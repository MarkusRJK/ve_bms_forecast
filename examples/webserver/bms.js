var VEdeviceClass = require( 've_bms_forecast' ).VitronEnergyDevice;
var bmvterminal = require("./bmv-terminal.js");
const interpolate = require('everpolate').linear;
const fs = require('fs');


// extend standard Array by unique function
// ES6: use Set or use lodash.js or underscore.js library
Array.prototype.unique = function() {
    // TODO: var -> let
    var a = this.concat();
    for(var i=0; i<a.length; ++i) {
        for(var j=i+1; j<a.length; ++j) {
            if(a[i] === a[j])
                a.splice(j--, 1);
        }
    }

    return a;
};


// \brief Charge characteristic when floating for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
class FloatChargeCharacteristic {

    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(cells, capacity) {
	this.actualVoltage = 0;
	this.actualCurrent = 0;
	const file = __dirname + '/charge_characteristic.json';
	fs.readFile(file, 'utf8', (err, data) => {
	    if (err) {
		//logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
		console.log("error parsing");
            } else {
		//logger.debug("Parse configuration (JSON format)");
		let cc = JSON.parse(data);

		// concat the time data, sort and make entries unique
		let tmp      = cc.current.hours.concat(cc.voltage.hours).unique();
		let timeTags = tmp.concat(cc.SOC.hours).unique();
		timeTags.sort(function(a, b){return a - b});
		
		let I  = interpolate(timeTags, cc.current.hours, cc.current.I);
		let U  = interpolate(timeTags, cc.voltage.hours, cc.voltage.U);
		// capacity in percent
		let CP = interpolate(timeTags, cc.SOC.hours,     cc.SOC.percent); 

		let cellCapacityScale = cells / capacity;
		let R = U.map(function (u, idx) {
		    return cellCapacityScale * u / I[idx];
		});

		if (R.length > 0 && CP.length > 0) {
		    this.resistance = [];
		    this.soc = []; // state of charge

		    this.resistance.push(R[0]);
		    this.soc.push(CP[0]);

		    // TODO: var -> let
		    for(var i = 1; i < R.length; ++i) {
			if(R[i-1] !== R[i])
			{
			    this.resistance.push(R[i]);
			    this.soc.push(CP[i]);
			}
		    }
		}
            }
	});
    }

    getSOC() {
	let soc = interpolate(this.actualVoltage/this.actualCurrent, this.resistance, this.soc);
	return soc;
    }

    setCurrent(I) {
	this.actualCurrent = I;
    }

    setVoltage(U) {
	this.actualVoltage = U;
    }
}


// \class Battery Management System
class BMS extends VEdeviceClass {
    constructor(cmd) {
        super();
	this.lowerBattery = new FloatChargeCharacteristic(6, 400);
	this.upperBattery = new FloatChargeCharacteristic(6, 400);

	// bmvdata.<component> = register(<n2UF>, <units>, <shortDescr>, <options>);
	//bmvdata.upperSOC       = register(1,      "%",     "Upper SOC",  {'precision': 0});
	//bmvdata.lowerSOC       = register(1,      "%",     "Upper SOC",  {'precision': 0});

	this.registerListener('batteryCurrent', this.lowerBattery.setCurrent.bind(this.lowerBattery));
        this.registerListener('batteryCurrent', this.upperBattery.setCurrent.bind(this.upperBattery));

         this.registerListener('midVoltage',     this.lowerBattery.setVoltage.bind(this.lowerBattery));
        this.registerListener('topVoltage',     this.upperBattery.setVoltage.bind(this.upperBattery));
    }

    this.getLowerSOC = function() {
	return this.lowerBattery.getSOC();
    }

    this.getUpperSOC = function() {
	return this.upperBattery.getSOC();
    }
}

module.exports.BMSInstance = new BMS();

