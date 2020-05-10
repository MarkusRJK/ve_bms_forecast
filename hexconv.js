exports.hexToSint = function(hex) {
    if (hex.length % 2 != 0) {
        hex = "0" + hex;
    }
    var num = parseInt(hex, 16);
    var maxVal = Math.pow(2, hex.length / 2 * 8);
    if (num > maxVal / 2 - 1) {
        num = num - maxVal
    }
    return num;
}

exports.hexToUint = function(hex) {
    return parseInt(hex, 16);
}

exports.hexToOnOff = function(hex) {
    if (parseInt(hex, 16) == 0)
	return 'OFF';
    else return 'ON';
}
