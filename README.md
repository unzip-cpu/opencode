## 构建二进制文件
```jupyter
本地压缩源代码，git archive -o dev-webui.zip HEAD
将源代码放到linux服务器上的/usr/local/app/abi/opencode/src目录下，不能在win10下打包
cd /usr/local/app/abi/opencode/src
export OPENCODE_VERSION=2.2.5
bun install
bun run packages/cli/script/build.ts
```

## 13.12部署
- opencode service set hostname 0.0.0.0
- opencode service set port 49374（仅设置一次）
- opencode service set password "Hduap@001"（仅设置一次）
- 


## 本地启动
```jupyter
在opencode根目录启动后端：bun dev serve --port 4096
在opencode/packages/app启动前端：bun dev
```

## 如何与bisheng联调
在目录启动opencode\packages\cli\dist\cli-windows-x64\bin目录下启动opencode.exe service start

## 执行sqlite3语句
sqlite3 "$(opencode debug paths db)" "SELECT * FROM project;"

