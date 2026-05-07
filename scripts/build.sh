#!/bin/bash

# 确保在项目根目录
cd "$(dirname "$0")/.."

echo "🚀 Starting build process..."

# 清理旧的构建文件
rm -rf dist

# 安装依赖（确保所有依赖都已安装）
echo "📦 Installing dependencies..."
npm install

# 检查 icon.icns 是否存在
if [ ! -f "icon.icns" ]; then
    echo "⚠️ Warning: icon.icns not found, using default electron icon."
fi

# 开始打包
echo "🔨 Building DMG..."
npm run build

echo "✅ Build complete! You can find the DMG in the 'dist' folder."
