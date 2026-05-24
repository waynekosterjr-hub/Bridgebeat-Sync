const e = require('electron');
console.log('type', typeof e);
if (e && typeof e === 'object') {
  console.log('keys', Object.keys(e).slice(0,20).join(','));
  console.log('has app', !!e.app);
}
