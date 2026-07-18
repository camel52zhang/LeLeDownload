const { execSync } = require('child_process');
const path = require('path');

const projectDir = 'D:\\tools\\qlcaw\\lele_download';
const nodePath = 'd:\\Program Files\\QClaw\\v0.2.29.592\\resources\\openclaw\\config\\bin\\node\\node.exe';

process.chdir(projectDir);

try {
  // 设置PATH
  const nodeDir = path.dirname(nodePath);
  process.env.PATH = nodeDir + ';' + process.env.PATH;
  
  console.log('Installing dependencies...');
  execSync('npm install', { 
    stdio: 'inherit',
    env: { ...process.env, PATH: nodeDir + ';' + process.env.PATH }
  });
  console.log('Done!');
} catch (e) {
  console.error('Error:', e.message);
}