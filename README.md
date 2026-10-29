## 构建二进制文件
```jupyter
cd opencode\packages\cli\script
set OPENCODE_VERSION=2.2.0
bun run build
```

## 13.12部署
- opencode service set port 49374
- opencode service set password "Hduap@001"
-将opencode\packages\cli\dist\cli-linux-arm64\bin\opencode放到192.168.13.12的/usr/local/bin/目录下


## 本地启动
```jupyter
在opencode根目录启动后端：bun dev serve --port 4096
在opencode/packages/app启动前端：bun dev
```

## 如何与bisheng联调
在目录启动opencode\packages\cli\dist\cli-windows-x64\bin目录下启动opencode.exe service start

