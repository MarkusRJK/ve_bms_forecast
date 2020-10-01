var VEdeviceClass = require( 've_bms_forecast' ).VitronEnergyDevice;
const interpolate = require('everpolate').linear;
var fs = require('fs');

// extend standard Array by unique function
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

function isNumber(value) 
{
    return typeof value === 'number';// && isFinite(value);
}


// \brief Charge characteristic when floating for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
class FloatChargeCharacteristic {

    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(cells, capacity) {
	//logger.trace("FloatChargeCharacteristic::constructor");
	this.actualVoltage = 0;
	this.actualCurrent = 0;
	this.resistance = [];
	this.soc = []; // state of charge

	const filename = __dirname + '/charge_characteristic.json';
	fs.readFile(filename, 'utf8', (err, data) => {
	    if (err) {
		//logger.error(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
		console.log(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
		console.log(err.stack);
            } else {
		//logger.debug("Parse configuration (JSON format)");
		let cc = JSON.parse(data).floatcharge;
		
		// concat the time data, sort and make entries unique
		let tmp      = cc.current.hours.concat(cc.voltage.hours).unique();
		let timeTags = tmp.concat(cc.SOC.hours).unique();
		timeTags.sort(function(a, b){return a - b});
		
		let I  = interpolate(timeTags, cc.current.hours, cc.current.I);
		let U  = interpolate(timeTags, cc.voltage.hours, cc.voltage.U);
		// capacity in percent
		let CP = interpolate(timeTags, cc.SOC.hours,     cc.SOC.percent); 
		console.log("CP " + CP);

		let cellCapacityScale = cells / capacity;
		let R = U.map(function (u, idx) {
		    return cellCapacityScale * u / I[idx];
		});

		if (R.length > 0 && CP.length > 0) {
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
	if (this.actualCurrent <= 0) return 0;
	let atValue = this.actualVoltage/this.actualCurrent;
	let soc = 0;
	// it may take a while till charge_characteristic.json is read
	if (this.resistance.length > 0 && this.soc.length > 0) 
	    soc = interpolate(atValue, this.resistance, this.soc);
	console.log("SOC = " + soc);
	return soc;
    }

    setCurrent(current) {
	let I = parseFloat(current);
	// my charger can max deliver 45A
	if (! isNaN(I) && I <= 45.0) {
	    this.actualCurrent = I / 1000.0;
	}
    }

    setVoltage(voltage) {
	let U = parseFloat(voltage);
	if (! isNaN(U) && U <= 15.0 && U >= 10.0) {
	    this.actualVoltage = U / 1000.0;
	}
    }
}

// \brief Charge characteristic when discharging for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
class DischargeCharacteristic {

    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(cells, capacity) {
	//logger.trace("FloatChargeCharacteristic::constructor");
	this.actualVoltage = 0;
	this.actualCurrent = 0;
	this.resistance = [];
	this.soc = []; // state of charge

	const filename = __dirname + '/charge_characteristic.json';
	fs.readFile(filename, 'utf8', (err, data) => {
	    if (err) {
		//logger.error(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
		console.log(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
		console.log(err.stack);
            } else {
		//logger.debug("Parse configuration (JSON format)");
		let cc = JSON.parse(data).discharge;
		
		// concat the time data, sort and make entries unique
		// let tmp      = cc.current.hours.concat(cc.voltage.hours).unique();
		// let timeTags = tmp.concat(cc.SOC.hours).unique();
		// timeTags.sort(function(a, b){return a - b});
		
		// let I  = interpolate(timeTags, cc.current.hours, cc.current.I);
		// let U  = interpolate(timeTags, cc.voltage.hours, cc.voltage.U);
		// // capacity in percent
		// let CP = interpolate(timeTags, cc.SOC.hours,     cc.SOC.percent); 
		// console.log("CP " + CP);

		// let cellCapacityScale = cells / capacity;
		// let R = U.map(function (u, idx) {
		//     return cellCapacityScale * u / I[idx];
		// });

		// if (R.length > 0 && CP.length > 0) {
		//     this.resistance.push(R[0]);
		//     this.soc.push(CP[0]);

		//     // TODO: var -> let
		//     for(var i = 1; i < R.length; ++i) {
		// 	if(R[i-1] !== R[i])
		// 	{
		// 	    this.resistance.push(R[i]);
		// 	    this.soc.push(CP[i]);
		// 	}
		//     }
		// }
            }
	});
    }

    getSOC() {
	if (this.actualCurrent <= 0) return 0;
	let atValue = this.actualVoltage/this.actualCurrent;
	let soc = 0;
	// it may take a while till charge_characteristic.json is read
	if (this.resistance.length > 0 && this.soc.length > 0) 
	    soc = interpolate(atValue, this.resistance, this.soc);
	console.log("SOC = " + soc);
	return soc;
    }

    setCurrent(current) {
	let I = parseFloat(current);
	// my charger can max deliver 45A
	if (! isNaN(I) && I <= 45.0) {
	    this.actualCurrent = I / 1000.0;
	}
    }

    setVoltage(voltage) {
	let U = parseFloat(voltage);
	if (! isNaN(U) && U <= 15.0 && U >= 10.0) {
	    this.actualVoltage = U / 1000.0;
	}
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

    getLowerSOC() {
	return this.lowerBattery.getSOC();
    }

    getUpperSOC() {
	return this.upperBattery.getSOC();
    }
}


module.exports.BMSInstance = new BMS();

