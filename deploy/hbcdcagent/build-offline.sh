#!/usr/bin/env bash
# build-offline.sh — 数智疾控离线部署打包脚本（有网构建机执行）。
#
# 用法：
#   ./deploy/hbcdcagent/build-offline.sh
#
# 可选环境变量：
#   PLATFORM          构建目标架构          (default: linux/amd64，150 是 x86-64)
#   BASE_IMG          底座镜像名/tag        (default: zeroclaw:debian)
#   DAEMON_IMG        daemon 运行镜像名/tag  (default: hbcdcagent-daemon:local)
#   BFF_IMG           BFF 镜像名/tag        (default: hbcdcagent-bff:local)
#   OUT_DIR           交付目录              (default: dist-offline)
#   DOCKER_ENGINE_TGZ 150 装 Docker 引擎的离线包（如 git/docker/docker-24.0.0.tgz），有则拷入
#   COMPOSE_BIN       compose 插件二进制（docker-compose-linux-x86_64，v2.10+），有则拷入
#
# 产物：${OUT_DIR}/ 下
#   hbcdcagent-images.tar.gz   两个业务镜像（docker save | gzip）
#   docker-compose.yml         编排文件
#   .env（或 env.example）     配置与密钥
#   [docker-24.0.0.tgz]        可选，Docker 引擎离线包
#   [docker-compose]           可选，compose 插件二进制
#
# 无网 150 上的安装顺序（不在本脚本内，见 docs/分析/数智疾控Docker离线部署手册.md）：
#   1) 解压 docker-24.0.0.tgz 装引擎（基础）
#   2) 装 compose 插件到 ~/.docker/cli-plugins/docker-compose
#   3) docker load 业务镜像，docker compose up -d

set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────────────────────
PLATFORM="${PLATFORM:-linux/amd64}"
BASE_IMG="${BASE_IMG:-zeroclaw:debian}"
DAEMON_IMG="${DAEMON_IMG:-hbcdcagent-daemon:local}"
BFF_IMG="${BFF_IMG:-hbcdcagent-bff:local}"
OUT_DIR="${OUT_DIR:-dist-offline}"

# 定位仓库根（脚本在 deploy/hbcdcagent/ 下，往上两级）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_SRC="${SCRIPT_DIR}/docker-compose.yml"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE="${SCRIPT_DIR}/env.example"

echo "==> 数智疾控离线打包"
echo "    PLATFORM: ${PLATFORM}"
echo "    仓库根:   ${REPO_ROOT}"
echo "    输出目录: ${OUT_DIR}"
echo ""

# ── 0. 校验 ────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker 未安装或不在 PATH。" >&2
  exit 1
fi
if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon 未运行。本机用 Colima 时先执行：colima start" >&2
  exit 1
fi

cd "${REPO_ROOT}"

# ── 1. 构建 Debian 底座（zeroclaw + zerocode + web/dist） ──────────────────
echo "==> [1/4] 构建底座 ${BASE_IMG}"
docker build --platform "${PLATFORM}" -f Dockerfile.debian -t "${BASE_IMG}" .

# ── 2. 叠 Python/R 运行层 ─────────────────────────────────────────────────
echo "==> [2/4] 构建 daemon 运行镜像 ${DAEMON_IMG}"
docker build --platform "${PLATFORM}" \
  -f deploy/hbcdcagent/Dockerfile.daemon \
  --build-arg "BASE=${BASE_IMG}" \
  -t "${DAEMON_IMG}" .

# ── 3. 构建 BFF ────────────────────────────────────────────────────────────
echo "==> [3/4] 构建 BFF 镜像 ${BFF_IMG}"
docker build --platform "${PLATFORM}" -f deploy/hbcdcagent/Dockerfile.bff -t "${BFF_IMG}" .

# ── 4. 导出交付物 ─────────────────────────────────────────────────────────
echo "==> [4/4] 导出到 ${OUT_DIR}/"
mkdir -p "${OUT_DIR}"

echo "    - 导出业务镜像 tar"
docker save "${DAEMON_IMG}" "${BFF_IMG}" | gzip > "${OUT_DIR}/hbcdcagent-images.tar.gz"

echo "    - 收集 docker-compose.yml"
cp "${COMPOSE_SRC}" "${OUT_DIR}/docker-compose.yml"

if [[ -f "${ENV_FILE}" ]]; then
  echo "    - 收集 .env（已填密钥，勿提交）"
  cp "${ENV_FILE}" "${OUT_DIR}/.env"
else
  echo "    - 未找到 .env，拷 env.example 模板（需自行填密钥）"
  cp "${ENV_EXAMPLE}" "${OUT_DIR}/env.example"
  echo "WARN: 未提供 ${ENV_FILE}，交付包内是 env.example，上线前须填真实密钥。" >&2
fi

# 可选：Docker 引擎离线包 / compose 插件二进制
if [[ -n "${DOCKER_ENGINE_TGZ:-}" && -f "${DOCKER_ENGINE_TGZ}" ]]; then
  echo "    - 收集 Docker 引擎离线包"
  cp "${DOCKER_ENGINE_TGZ}" "${OUT_DIR}/"
fi
if [[ -n "${COMPOSE_BIN:-}" && -f "${COMPOSE_BIN}" ]]; then
  echo "    - 收集 compose 插件二进制"
  cp "${COMPOSE_BIN}" "${OUT_DIR}/docker-compose"
  chmod +x "${OUT_DIR}/docker-compose"
fi

echo ""
echo "==> 交付清单 ${OUT_DIR}/："
ls -lh "${OUT_DIR}" | sed 's/^/    /'
echo ""
echo "完成。拷贝 ${OUT_DIR}/ 到 150 后，按部署手册 §6 load + compose up。"
