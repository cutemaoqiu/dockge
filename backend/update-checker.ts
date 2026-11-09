import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import { log } from "./log";

export type ImageUpdateStatus = "update" | "ok" | "unknown";

export interface StackUpdate {
    status : ImageUpdateStatus;
    /** Names of the services that have a newer image */
    services : string[];
}

// Manifest 只是几 KB，用 GET 比 HEAD 兼容性更好（部分 registry 对 HEAD 返回 404）
const MANIFEST_ACCEPT = [
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/**
 * Split an image reference into registry / repository / tag.
 * `name` keeps the reference as written (without tag), so it can be matched against RepoDigests.
 */
export function parseImageRef(image : string) {
    let name = image.split("@")[0];
    let tag = "latest";
    const colon = name.lastIndexOf(":");
    if (colon > name.lastIndexOf("/")) {
        tag = name.slice(colon + 1);
        name = name.slice(0, colon);
    }

    let registry = "registry-1.docker.io";
    let repo = name;
    const segments = name.split("/");
    const first = segments[0];
    const hasRegistryHost = segments.length > 1
        && (first.includes(".") || first.includes(":") || first === "localhost");

    if (hasRegistryHost) {
        registry = first;
        repo = segments.slice(1).join("/");
    } else if (!name.includes("/")) {
        repo = "library/" + name;
    }

    if ([ "docker.io", "index.docker.io" ].includes(registry)) {
        registry = "registry-1.docker.io";
    }

    return {
        registry,
        repo,
        tag,
        name,
    };
}

export async function localDigest(image : string) : Promise<string | undefined> {
    const res = await childProcessAsync.spawn("docker", [ "image", "inspect", "--format", "{{json .RepoDigests}}", image ], {
        encoding: "utf-8",
    });
    const digests : string[] = JSON.parse(res.stdout?.toString() || "[]");
    const { name } = parseImageRef(image);
    const matched = digests.find((digest) => digest.split("@")[0] === name) || digests[0];
    return matched?.split("@")[1];
}

export async function remoteDigest(image : string) : Promise<string> {
    // Pinned by digest, there is nothing to compare against
    if (image.includes("@sha256:")) {
        return image.split("@")[1];
    }

    const { registry, repo, tag } = parseImageRef(image);
    const url = `https://${registry}/v2/${repo}/manifests/${tag}`;
    const request = (token? : string) => fetch(url, {
        headers: {
            Accept: MANIFEST_ACCEPT,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });

    let res = await request();
    if (res.status === 401) {
        const auth = res.headers.get("www-authenticate") || "";
        const realm = /realm="([^"]+)"/.exec(auth)?.[1];
        const service = /service="([^"]+)"/.exec(auth)?.[1];
        if (!realm) {
            throw new Error("registry requires credentials");
        }
        const tokenURL = new URL(realm);
        if (service) {
            tokenURL.searchParams.set("service", service);
        }
        tokenURL.searchParams.set("scope", `repository:${repo}:pull`);
        const tokenRes = await fetch(tokenURL);
        if (!tokenRes.ok) {
            throw new Error(`token request failed: ${tokenRes.status}`);
        }
        const body = await tokenRes.json() as { token? : string, access_token? : string };
        const token = body.token || body.access_token;
        if (!token) {
            throw new Error("registry returned no token");
        }
        res = await request(token);
    }

    if (!res.ok) {
        throw new Error(`manifest request failed: ${res.status}`);
    }
    const digest = res.headers.get("docker-content-digest");
    if (!digest) {
        throw new Error("registry returned no digest");
    }
    return digest;
}

async function checkImage(image : string) : Promise<ImageUpdateStatus> {
    try {
        const local = await localDigest(image);
        if (!local) {
            // 本地构建的镜像（没有 RepoDigests），无从比较
            return "unknown";
        }
        return (await remoteDigest(image)) === local ? "ok" : "update";
    } catch (e) {
        if (e instanceof Error) {
            log.debug("update-check", `${image}: ${e.message}`);
        }
        return "unknown";
    }
}

/** Collect service images from a compose YAML, skipping anything that needs env substitution */
function imagesOf(composeYAML : string) : { name : string, image : string }[] {
    const list : { name : string, image : string }[] = [];
    try {
        const config = yaml.parse(composeYAML);
        const services = (config?.services || {}) as Record<string, { image? : unknown }>;
        for (const [ name, service ] of Object.entries(services)) {
            const image = service?.image;
            if (typeof image === "string" && image && !image.includes("${")) {
                list.push({
                    name,
                    image,
                });
            }
        }
    } catch (e) {
        // Broken YAML is reported elsewhere, nothing to check here
    }
    return list;
}

class UpdateChecker {
    private states = new Map<string, StackUpdate>();
    private tasks = new Map<string, Promise<StackUpdate>>();

    get(stackName : string) : StackUpdate | undefined {
        return this.states.get(stackName);
    }

    /** Check one stack, reusing an in-flight check of the same stack */
    refresh(stackName : string, composeYAML : string) : Promise<StackUpdate> {
        let task = this.tasks.get(stackName);
        if (!task) {
            task = this.check(composeYAML)
                .then((state) => {
                    this.states.set(stackName, state);
                    if (state.status === "update") {
                        log.info("update-check", `${stackName}: 有新版本 (${state.services.join(", ")})`);
                    }
                    return state;
                })
                .finally(() => this.tasks.delete(stackName));
            this.tasks.set(stackName, task);
        }
        return task;
    }

    async refreshAll(stacks : Map<string, string>) {
        for (const [ stackName, composeYAML ] of stacks) {
            try {
                await this.refresh(stackName, composeYAML);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("update-check", `${stackName}: ${e.message}`);
                }
            }
        }
    }

    private async check(composeYAML : string) : Promise<StackUpdate> {
        const services = imagesOf(composeYAML);
        const updated : string[] = [];
        let allOk = true;

        for (const service of services) {
            const status = await checkImage(service.image);
            if (status === "update") {
                updated.push(service.name);
            }
            if (status !== "ok") {
                allOk = false;
            }
        }

        return {
            status: updated.length > 0 ? "update" : (allOk ? "ok" : "unknown"),
            services: updated,
        };
    }
}

export const updateChecker = new UpdateChecker();
