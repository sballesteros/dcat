var archy = require('archy');

var s = archy({
  label: '.',
  nodes: [
    {
      label: 'mydpkg',
      nodes: [
        {
          label: 'data_modules',
          nodes: ['a', 'b', 'c']        
        }
      ]
    }
  ]
});

console.log(s);
