const fs = require('fs');
const f = 'D:\\tools\\qlcaw\\lele_download\\src\\components\\DownloadItem.tsx';
let c = fs.readFileSync(f, 'utf8');

// Make action buttons always visible (remove hover-only opacity trick)
// and add responsive behavior for narrow screens
c = c.replace(
  '<div className="flex items-center gap-1 flex-shrink-0 group-hover:opacity-100 transition-opacity" style={{ opacity: task.status === \'completed\' || task.status === \'failed\' ? 1 : undefined }}>',
  '<div className="flex items-center gap-1 flex-shrink-0">'
);

// Also make the filename/status row wrap better on narrow screens
c = c.replace(
  '<div className="flex items-center gap-3 flex-wrap">',
  '<div className="flex items-center gap-2 flex-wrap">'
);

fs.writeFileSync(f, c);
console.log('Made actions always visible and improved wrapping');
