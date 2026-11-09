import assert from "node:assert";
import { parseImageRef, remoteDigest } from "../backend/update-checker";

// parseImageRef 归一化后的 repo 必须和 Docker 记录的 RepoDigests 对得上
const cases : [string, string, string, string][] = [
    // image, registry, repo, tag
    [ "nginx", "registry-1.docker.io", "library/nginx", "latest" ],
    [ "alpine:3.19", "registry-1.docker.io", "library/alpine", "3.19" ],
    [ "linuxserver/sonarr:latest", "registry-1.docker.io", "linuxserver/sonarr", "latest" ],
    [ "ghcr.io/foo/bar:1.2", "ghcr.io", "foo/bar", "1.2" ],
    [ "lscr.io/linuxserver/sabnzbd:latest", "lscr.io", "linuxserver/sabnzbd", "latest" ],
    [ "registry.cn-shanghai.aliyuncs.com/x/y:v1", "registry.cn-shanghai.aliyuncs.com", "x/y", "v1" ],
    [ "localhost:5000/app:dev", "localhost:5000", "app", "dev" ],
];

for (const [ image, registry, repo, tag ] of cases) {
    const parsed = parseImageRef(image);
    assert.strictEqual(parsed.registry, registry, `${image} registry`);
    assert.strictEqual(parsed.repo, repo, `${image} repo`);
    assert.strictEqual(parsed.tag, tag, `${image} tag`);
}

// 真实 registry：匿名 token 流程能拿到 manifest digest
const digest = await remoteDigest("alpine:3.19");
assert.match(digest, /^sha256:[a-f0-9]{64}$/, `unexpected digest: ${digest}`);

console.log(`update-checker self-check passed (alpine:3.19 = ${digest})`);
