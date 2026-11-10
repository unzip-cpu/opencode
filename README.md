## 构建二进制文件
```jupyter
本地压缩源代码，git archive -o dev-webui.zip HEAD
将源代码放到linux服务器上的/usr/local/app/abi/opencode/src目录下，不能在win10下打包
cd /usr/local/app/abi/opencode/src
export OPENCODE_VERSION=2.2.5
bun install
bun run packages/cli/script/build.ts
先停掉opencode service stop
/usr/local/app/abi/opencode/src/packages/cli/dist/cli-linux-arm64/bin/目录下的opencode文件复制到/usr/local/bin/目录下
启动opencode service start
```

## 13.12部署
- opencode service set hostname 0.0.0.0（仅设置一次）
- opencode service set port 49374（仅设置一次）
- opencode service set password "Hduap@001"（仅设置一次）
- 


## 本地启动
```jupyter
在opencode根目录启动后端：bun dev serve（启动成功后控制台会输出本次登录需要用要的临时密码，用于后面的登录环节）
在opencode/packages/app启动前端：bun dev
修改：packages/app/src/shell/routes/routes.tsx，将/路由的注释解开
前端访问 http://loaclhost:3000（点击 user password 后 输入密码）
运行数据存储在C:\Users\gehongzhi\.local\share\opencode
```

## 如何与bisheng联调
在目录启动opencode\packages\cli\dist\cli-windows-x64\bin目录下启动opencode.exe service start

## 执行sqlite3语句
sqlite3 "$(opencode debug paths db)" "SELECT * FROM project;"

