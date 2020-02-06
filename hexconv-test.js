var conv = require('./hexconv');

var res;

// 8-bit integers
res = conv.hexToSint("FF"); // -1
process.stdout.write('FF: ' + res + '\n');
res = conv.hexToSint("7F");
process.stdout.write('7F:' + res + '\n');
res = conv.hexToSint("A"); // same as "0A", 10
process.stdout.write('A:' + res + '\n');

// 16-bit integers
res = conv.hexToSint("FFF"); // same as "0FFF", 4095
process.stdout.write('FFF: ' + res + '\n');
res = conv.hexToSint("FFFF"); // -1
process.stdout.write('FFFF: ' + res + '\n');
res = conv.hexToSint("7FFF"); // max int 16
process.stdout.write('7FFF: ' + res + '\n');

// 32-bit integers
res = conv.hexToSint("FFFFFFF"); // same as "0FFF FFFF"
process.stdout.write('FFFFFFF: ' + res + '\n');
res = conv.hexToSint("FFFFFFFF"); // -1
process.stdout.write('FFFFFFFF: ' + res + '\n');
res = conv.hexToSint("7FFFFFFF"); // max int 16
process.stdout.write('7FFFFFFF: ' + res + '\n');

