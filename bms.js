var VEdeviceClass = require( 've_bms_forecast' ).VitronEnergyDevice;
var bmvterminal = require("./bmv-terminal.js");


// \class Battery Management System
class BMS extends VEdeviceClass {
    constructor(cmd) {
        super();
    }
}

module.exports.BMSInstance = new BMS();


