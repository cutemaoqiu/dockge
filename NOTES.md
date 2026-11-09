# dockge（自建镜像：镜像更新提示）

上游 `louislam/dockge` 不做「容器有新版本」提示（社区 issue 挂了两年，1.5.0 仍未做），这个 fork 补了这块。

- Fork：`https://github.com/cutemaoqiu/dockge`（remote `origin`，分支 `master`，基于上游 1.5.0）
- 本机源码：`micro-project/dockge`；NAS 构建源 `/opt/dockge-src`；运行镜像 `dockge-custom:local`
- 部署/重建：`bash deploy.sh`（本机出前端产物 → tar 到 NAS → NAS 上 `docker build` → 重起 `/opt/dockge`）

## 行为

- 列表页栈名后有橙色「有更新」角标，悬停显示是哪些服务。
- 栈详情页同样的角标落在「更新」按钮里；点它就是原来的 pull + up，更新完角标自动消失（前端重拉 stack、后端重查该栈）。
- 检查时机：容器启动 15 秒后一次，之后每 6 小时一次；检出更新打一条 `UPDATE-CHECK` INFO 日志。
- 判定：`docker image inspect` 取本地 tag 的 RepoDigests，匿名拉 registry manifest 取 `Docker-Content-Digest`，不等即有更新。`image:` 里带 `${VAR}` 的服务跳过不查。
- 没结论时不显示角标（`unknown`）：本地 build 的镜像（无 RepoDigests，如 `xianyu-*-local`）、私有仓库、registry 不可达。

## 已知限制

- 比的是「本地 tag 是否落后于 registry」，不是「运行中容器用的镜像」。手动 `docker pull` 但没 `up -d` 时角标会消失，容器仍是旧的。
- 私有仓库没做鉴权（只走匿名 token），一律 `unknown`。
- 合上游：`git remote add upstream https://github.com/louislam/dockge && git fetch upstream && git merge upstream/master`，再 `bash deploy.sh`。

## 自检

`npx tsx extra/test-update-checker.ts`（镜像引用解析 + 真拉一次 alpine manifest digest）。
容器内：`docker exec -w /app dockge-dockge-1 tsx extra/test-update-checker.ts`。

## 回滚

`/opt/dockge/compose.yaml.bak-20261109` 是上游版；把 `image:` 改回 `louislam/dockge:1` 再 `docker compose up -d`。
