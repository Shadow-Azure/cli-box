使用 @README.md 中的cli命令完成下面场景的验证，测试1，2，3，4不要直接调用接口：
1. /superpowers:systematic-debugging 测试一下，release.sh编译构建后，使用release中的cli打开opencode，然后使用cli输入"你是谁？"， 并出发回车发送。这个过程每一步都截图分析（不要用--with-frame），保存到@release_test/${{yyyy-mm-dd hh-mm-ss}}文件夹下。最后使用`cli-box close <id>`关闭沙箱，并使用`cli-box list`进行验证
2. /superpowers:systematic-debugging 使用 @release.sh 打包编译release，然后你进行一个简单场景的测试，场景一：在沙箱启动claude以后，回车确认，然后输入你是谁？然后出发回车发送。场景二：在沙箱启动zsh，然后输入echo "hello world"，然后回车发送。每一步操作后都截图保存到release_test/${{时间戳，yyyy-mm-dd-hh-mm-ss}}文件夹下（不要用--with-frame），然后检查截图结果，查看是否符合预期，注意读取图片前先判断图片是否存在问题
3. /superpowers:systematic-debugging 使用 @release.sh 打包编译release，然后先打开opencode，再打开zsh，分别CLI命令行截图两个窗口（不要用--with-frame），获取到的是各自的界面
4. 当前打开的claude，在回车确认后，判断界面上，不会有选项`Yes, I trust this folder`残留
5. 用`start opencode`命令，打开opencode，使用screenshot --with-frame进行截图，查看是否有边框
6. 新增测试点
  - pnpm dev 后 Electron 窗口正常打开
  - 终端日志显示 "Daemon started on port XXXX"
  - cli-box start zsh 创建新 Tab，xterm.js 显示 zsh 提示符
  - cli-box start claude 创建另一个 Tab，显示 Claude Code
  - Tab 切换正常（离屏定位策略）
  - 截图功能正常
  - 关闭一个 Tab 不影响其他 Tab
8. /superpowers:systematic-debugging 测试一下，release.sh编译构建后，使用release中的cli打开opencode，然后使用cli输入"你是谁？"， 并出发回车发送。这个过程每一步都适用`cli-box ui-inspect`获取当前CLI的信息，保存到`release_test/${{yyyy-mm-dd-hh-mm-ss}}`文件夹的txt文件中，进行验证
9. /superpowers:systematic-debugging 测试一下，release.sh编译构建后，使用release中的cli打开zsh，然后使用输入"echo 'hello world'"， 并出发回车发送。这个过程每一步都适用`cli-box ui-inspect`获取当前CLI的信息，保存到`release_test/${{yyyy-mm-dd-hh-mm-ss}}`文件夹的txt文件中，进行验证
10. 执行`sh release.sh`打包编译新的cli-box，然后通过CLI命令，执行下面流程，注意所有截图都放到`release_test/${{yyyy-mm-dd-hh-mm-ss}}`文件夹下 ：1. 打开chrome浏览器，并截图；2. 输入登录www.google.com，并截图；3. 点击搜索框，搜索框填入`github`，并截图；4. 回车出发搜索，并截图；5. 点击一个搜索结果打开新的网页，并截图 ；每一步都检查截图是否正确
11. 执行`sh release.sh`打包编译新的cli-box，然后通过CLI命令，执行下面流程，注意所有`ui-inspect`的输出都放到`release_test/${{yyyy-mm-dd-hh-mm-ss}}`文件夹的txt文件中 ：1. 打开chrome浏览器；2. 输入登录www.google.com；3. 点击搜索框，搜索框填入`github`；4. 回车出发搜索；5. 点击一个搜索结果打开新的网页 ；每一步都适用`cli-box ui-inspect`获取AX树，并校验获取的结果是否符合预期
12. 执行`sh release.sh`打包编译新的cli-box，然后通过CLI命令，执行下面流程：
  - 后面的每一步操作后都截图保存到release_test/${{时间戳，yyyy-mm-dd-hh-mm-ss}}文件夹下（不要用--with-frame）
  - `cli-box start "cd /Users/zn-ice/2026/openclaw-main && claude --dangerously-skip-permissions"`，回车确认; 然后输入“执行`pwd`命令”，然后回车发送，发送后等回复完成后使用scrollback获取信息存储在目标文件夹的一个txt文件中，然后查看pwd的输出是否为`/Users/zn-ice/2026/openclaw-main`。
  - 然后输入"请分析 @/Users/zn-ice/2026/openclaw-main 这个代码的实现逻辑，然后将结论告诉我"？然后出发回车发送。发送后等待执行结束，执行结束后进行截图，并校验图片是否处于最后的位置。
  - 然后还是在这个沙箱中，测试`screenshot --up`, `screenshot --top`, `scrollback`的命令，将截图或文本输出保存在目标文件夹路径下，并校验是否正确
13. 执行`sh release.sh`打包编译新的cli-box，然后通过CLI命令，执行下面流程：
  - 后面的每一步操作后都截图保存到release_test/${{时间戳，yyyy-mm-dd-hh-mm-ss}}文件夹下（不要用--with-frame）
  - `cli-box start "cd /Users/zn-ice/2026/openclaw-main && opencode"`，回车确认; 然后输入“执行`pwd`命令”，然后回车发送，发送后等回复完成后使用scrollback获取信息存储在目标文件夹的一个txt文件中，然后查看pwd的输出是否为`/Users/zn-ice/2026/openclaw-main`。
  - 然后输入"请分析 @/Users/zn-ice/2026/openclaw-main 这个代码的实现逻辑，然后将结论告诉我"？然后出发回车发送。实时使用`scrollback`查看当前状态，如果阻塞需要确认，则发送回车进行确认，并进行截图。一直等待执行结束，执行结束后进行截图，并校验图片是否处于最后的位置。
  - 然后还是在这个沙箱中，测试`screenshot --up`, `screenshot --top`, `scrollback`的命令，将截图或文本输出保存在目标文件夹路径下，并校验是否正确

在release_test/${{时间戳，yyyy-mm-dd-hh-mm-ss}}文件夹下，生成markdown的最终测试报告