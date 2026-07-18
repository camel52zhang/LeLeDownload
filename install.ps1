$env:QCLAW_CLI_NODE_BINARY = "d:\Program Files\QClaw\v0.2.29.592\resources\openclaw\config\bin\node\node.exe"
$env:QCLAW_NPM_CLI_JS = "d:\Program Files\QClaw\v0.2.29.592\resources\openclaw\config\bin\node\node_modules\npm\bin\npm-cli.js"
$env:QCLAW_NPM_GLOBAL_PREFIX = "C:\Users\zhang\AppData\Roaming\QClaw\npm-global"
$env:QCLAW_TASK_NODE_ENABLED = "1"

Set-Location "D:\tools\qlcaw\lele_download"
& "d:\Program Files\QClaw\v0.2.29.592\resources\openclaw\config\bin\node\npm.cmd" install