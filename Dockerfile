# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖（包括 devDependencies，用于编译）
RUN npm ci

# 复制源代码
COPY tsconfig.json ./
COPY src ./src

# 编译 TypeScript
RUN npm run build

# 生产阶段
FROM node:20-alpine

WORKDIR /app

# 安装生产依赖
COPY package*.json ./
RUN npm ci --only=production

# 从构建阶段复制编译后的代码
COPY --from=builder /app/dist ./dist

# 创建数据目录
RUN mkdir -p /app/data /app/data/logs /app/config

# 暴露端口（如果有 Web 接口的话）
# EXPOSE 3000

# 启动脚本：优先使用 /data 目录作为工作目录
ENV DATA_DIR=/data
ENV NODE_ENV=production

# 检查配置文件是否存在，如不存在则从默认位置复制
CMD ["sh", "-c", "npm start -- --data-dir ${DATA_DIR}"]
