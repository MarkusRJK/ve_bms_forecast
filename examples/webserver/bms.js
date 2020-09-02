const VEdevice = require( 've_bms_forecast' ).VitronEnergyDevice;
var bmvterminal = require("./bmv-terminal.js");


// \class Battery Management System
class BMS extends VEdevice {
    constructor(cmd) {
        super();
    }
}

module.exports.BMS = new BMS();


