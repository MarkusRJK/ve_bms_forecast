// WIP: class FloatVolume

var VEdeviceClass = require( 've_bms_forecast' ).VitronEnergyDevice;
const interpolate = require('everpolate').linear;
var fs = require('fs');
const Math = require('mathjs');

// extend standard Array by unique function
Array.prototype.unique = function() {
    let a = this.concat();
    for(let i=0; i<a.length; ++i) {
        for(let j=i+1; j<a.length; ++j) {
            if(a[i] === a[j])
                a.splice(j--, 1);
        }
    }
    return a;
};

function isNumber(value) 
{
    return typeof value === 'number'; // && isFinite(value);
}

function isInRange(value, min, max) {
    if (value < min) return false;
    if (value > max) return false;
    return true;
}

function getInRange(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getPercentualSOC(soc) {
    return getInRange(soc, 0.0, 100.0);
}


class Alarm {
    constructor(historyLength, silenceInMinutes) {
	this.alarmHistory = null;
	if (historyLength === null)
	    this.historyLength = 20;
	else
	    this.historyLength = historyLength;
	if (silenceInMinutes === null)
	    this.silenceInMS = 5 * 60 * 1000; // 5 minutes - in milliseconds
	else
	    this.silenceInMS = silenceInMinutes * 60 * 1000;
    }

    reduce() {
	if (this.alarmHistory.length <= this.historyLength) return;
	for (let id = 0; id < this.alarmHistory.length - this.historyLength; ++id)
	    if (! this.alarmHistory[id].isActive) delete this.alarmHistory[id];
    }

    persist() {
	// TODO: use JSON write to array of objects
    }

    raiseLow(failureText, actionText) {
	let alarm = { time     : new Date(),
		      failure  : failureText,
		      action   : actionText,
		      isAckn   : false,
		      isActive : true,
		      isAudible: false
		    };
	this.alarmHistory.push(alarm);
	this.reduce();
	this.persist();
    }

    raiseHigh(failureText, actionText) {
	// switch on Auditible alarm
	let alarm = { time     : new Date(),
		      failure  : failureText,
		      action   : actionText,
		      isAckn   : false,
		      isActive : true,
		      isAudible: true
		    };
	this.alarmHistory.push(alarm);
	this.reduce();
	this.persist();
    }

    acknowledge(id) {
	this.alarmHistory[id].isAckn = true;
    }

    // silence temporary for 5 minutes at any time
    silence(id) {
	this.alarmHistory[id].isAudible = false;
	setTimeout(function() {
	    this.alarmHistory[id].isAudible = true;
	}.bind(this), this.silenceInMS);

    }

    // first acknowledge then clear
    clear(id) {
	if (this.alarmHistory[id].isAckn) {
	    this.alarmHistory[id].isActive  = false;
	    this.alarmHistory[id].isAudible = false;
	}
    }

    isAnyAudible() {
	for (let id = 0; id < this.alarmHistory.length; ++id)
	    if (this.alarmHistory[id].isAudible) return true;
	return false;
    }
    
    isAnyActive() {
	for (let id = 0; id < this.alarmHistory.length; ++id)
	    if (this.alarmHistory[id].isActive) return true;
	return false;
    }
    
}

// consumes the flow and checks for violation of safe conditions
class Protection {
    constructor(config, actor) {
	// read config file
	fs.readFile(config, 'utf8', (err, data) => {
            if (err) {
                //logger.error(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
                console.log(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
                console.log(err.stack);
            } else {
                //logger.debug("Parse configuration (JSON format)");
                // charge characteristics data
                let conf = JSON.parse(data);
                this.maxChargeCurrent = conf.maxChargeCurrent; // 45A
                this.maxLoadCurrent = conf.maxLoadCurrent; // 150A
		this.minVoltage = conf.minVoltage; // 12V
		this.smallLoadCurrent = conf.smallLoadCurrent; // 8A
		this.maxPanelVoltage = conf.maxPanelVoltage; // 34V
            }
        });

	this.actor = actor;
	this.alarm = new Alarm();
    }

    setFlow(flow) {
	let I  = flow.getCurrent(); // FIXME: U and I in SI units?
	let UL = flow.getLowerVoltage(); // FIXME: flow should be current and upper / lower voltage
	let UU = flow.getUpperVoltage();
	if (I > Math.abs(this.maxChargeCurrent)) {
	    this.actor.setRelay(1);
	    this.alarm.raiseLow("Charging current too high: " + str(I), 
				"Switching load on battery");
	}
	if (I < -Math.abs(this.maxLoadCurrent)) {
	    this.actor.setRelay(0);
	    this.alarm.raiseLow("Load too high: " + str(I),
				"Removing load from battery");
	}
	if (UL < this.minVoltage && I < this.smallLoadCurrent) {
	    this.actor.setRelay(0);
	    this.alarm.raiseLow("Battery capacity too low; lower voltage drop to "
			     + str(UL) + " for small current " + str(I),
			     "Removing load from battery");
	}
	if (UU < this.minVoltage && I < this.smallLoadCurrent) {
	    this.actor.setRelay(0);
	    this.alarm.raiseLow("Battery capacity too low; upper voltage drop to "
				+ str(UU) + " for small current " + str(I),
				"Removing load from battery");
	}
	// if (PanelVoltage > this.maxPanelVoltage) {
	//     this.actor.setRelay(0);
	//     this.alarm.raiseLow("Panel voltage too high: " + str(PanelVoltage),
	//                         "Switching load on battery");
	// }
	// if (I < -5 && isInRange(UL + UU, 0, 12.5) && PanelVoltage > 32 && this.actor.getRelay() === 0) {
	//     // no action possible
	//     this.alarm.raiseHigh("Battery discharging although capacity left and sun is out",
	//                         "Disconnect MPPT controller");
	// }
    }

}


class Flow {

    // minCurrent, maxCurrent and currents in/output to/from setCurrent and getCurrent
    // must have the same "base" i.e. be SI or all in mA, microA etc.
    // minVoltage, maxVoltage and voltages in/output to/from setVoltage and getVoltage
    // must have the same "base"
    constructor(minCurrent, maxCurrent, minVoltage, maxVoltage) {
        this.actualVoltage = 0;
        this.actualCurrent = 0;
	this.minCurrent    = minCurrent;
	this.maxCurrent    = maxCurrent;
	this.minVoltage    = minVoltage;
	this.maxVoltage    = maxVoltage;
	// TODO: read from config file and use n2F conversion
	// Ladeschlussspannung 14.52V ungefährlich
	// Entladeschlussspannung 10.5V < 11V => warne bevor leer
	this.voltageAlarm  = new Alarm(  11.0, 14.52, "Voltage Alarm"); // TODO: append action func.
	// -150A brennt Invertersicherung minus 10%
	// 45A brennt Ladereglersicherung minus 10%
	this.currentAlarm  = new Alarm(-135.0, 41.00, "Current Alarm"); // TODO: append action func.
    }
    
    // \param current in a scale such that current * scaleCurrent results in ampers
    //        rather than milli ampers or so
    setCurrent(current) {
        let I = parseFloat(current);
        console.log("I = " + I);
        if (! isNaN(I)) {
	    // if (! isInRange(I, this.minCurrent, this.maxCurrent))
	    //    device Alarm: I out of range minCurrent, maxCurrent - device fault
	    if (this.currentAlarm.isAlarming(I))
		this.currentAlarm.raise();
	    else this.actualCurrent = I; // FIXME: justification for min/maxCurrent
	}
    }

    getCurrent() {
        return this.actualCurrent;
    }

    // \param voltage in a scale such that voltage * scaleVoltage results in volts
    //        rather than milli volts or so
    setVoltage(voltage) {
        let U = parseFloat(voltage);
        console.log("U = " + U);
        if (! isNaN(U)) {
	    // if (! isInRange(U, this.minVoltage, this.maxVoltage))
	    //    device Alarm: U out of range minVoltage, maxVotage - device fault
	    if (Math.abs(U) < 1 && this.voltageAlarm.isAlarming(U))
		this.currentAlarm.raise();
	    else this.actualVoltage = U;
        }
    }

    getVoltage() {
        return this.actualVoltage;
    }

    getResistance() {
        if (this.actualCurrent === 0) return 0;
        return this.actualVoltage / this.actualCurrent;
    }

    getPower() {
        return this.actualVoltage * this.actualCurrent;
    }
}

class RestingCharacteristic
{
    // Bleiakku: ladeschlussspannung = 2.42V/Zelle -> 14.52
    //           Ladeerhaltungspann. = 2.23V/Zelle
    //           Entladeschlusspannung = 1,75V/Zelle -> 10.5V

    // Gel Battery:  
    // 12.0V 12.00 11.76 11.98  0%
    // 12.2V 12.25 12.00        25%
    // 12.3V 12.40 12.30 12.40  50%
    // 12.5V 12.60 12.55        75%
    // 12.8V 12.80 12.78 12.80 100%
    //               ^ am zuverlaessigsten
    constructor() {
	// taken the average of the above voltages
	// TODO: read from file
        this.voltage = [11.935, 12.15, 12.35, 12.55,  12.795];
        this.soc     = [ 0.0,   25.0,  50.0,  75.0,  100.0];
	// TODO: read from file
	this.maxRestingCurrent = 0.05; // 50mA
    }

    isApplicable(flow) {
	return flow.getCurrent() <= Math.abs(this.maxRestingCurrent);
    }

    getSOC(flow) {
        let soc = interpolate(flow.getVoltage(), this.voltage, this.soc);
        return getPercentualSOC(soc);
    }
}


class IntegralOverTime
{
    constructor(value, timeStamp) {
        this.integral = 0;
        this.lowerIntegral = 0;
        this.upperIntegral = 0;
        this.lastValue    = value;
        if (timeStamp !== undefined && timeStamp !== null)
            this.lastTime = timeStamp;
        else
            this.lastTime = new Date(); // FIXME: new Date in constructor causes long first duration
        this.firstTime    = this.lastTime;
        this.isAscending  = false;
        this.isDescending = false;
	this.offset       = 0;
    }

    setOffset(offset) {
	this.offset = offset;
    }

    add(value, timeStamp)
    {
        let currentTime = 0;
        const duration = timeStamp - this.lastTime; // milliseconds
        this.lastTime = timeStamp;
        console.log("measured duration: " + duration);
        let lower = 0;
        let upper = 0;
        if (this.lastValue > value)
        {
            lower = duration * value;
            upper = duration * this.lastValue;
            this.isAscending = false;
        }
        else
        {
            lower = duration * this.lastValue;
            upper = duration * value;
            this.isAscending = true;
        }
        if (this.lastValue !== value)
        {
            this.isDescending = ! this.isAscending;
        }
        else
        {
            this.isAscending = this.isDescending = false;
        }
        this.lowerIntegral += lower;
        this.upperIntegral += upper;
        this.integral += 0.5 * (lower + upper);
        this.lastValue = value;
    }

    getIntegral()
    {
        return this.offset + this.integral;
    }

    isAscendingTrend()
    {
        return this.isAscending;
    }

    isDescendingTrend()
    {
        return this.isDescending;
    }

    getDuration()
    {
        return this.lastTime - this.firstTime;
    }

    getLastTimeStamp()
    {
        return this.lastTime;
    }

    getAvgValue()
    {
        return this.integral / this.getDuration();
    }

    getLowerIntegral()
    {
        return this.offset + this.lowerIntegral;
    }

    getUpperIntegral()
    {
        return this.offset + this.upperIntegral;
    }
}


class Charge extends IntegralOverTime {
    // FIXME: rethink: do we need to hand over value/timestamp here, if so get it right
    constructor(value, timeStamp) {
	super(value, timeStamp);

	// FIXME: the following isn't defined
	this.ntuFactorCurrent  = bmvdata.batteryCurrent.nativeToUnitFactor;
    }

    addCurrent(current, timeStamp) {
	let currentTime = 0;
	if (timeStamp !== undefined && timeStamp !== null)
            currentTime = timeStamp;
        else
            currentTime = new Date(); // time in milliseconds since epoch
	this.add(current * this.ntuFactorCurrent, currentTime * 0.001);
    }
}



// \brief Charge characteristic when floating for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
// Bleiakku: ladeschlussspannung = 2.42V/Zelle -> 14.52
class FloatChargeCharacteristic {

    // \details The float charge characteristic is given by the file
    //          charge_characteristic.json json object floatcharge.
    //          The voltages are typically specified by cells.
    //          The currents are typically specified based on the
    //          nominal capacity. What does that mean (example)?
    //          Lead acid based batteries (better accumulators)
    //          as used for cars, solar systems etc. often have
    //          12 V which means 6 cells of 2 Volts.
    //          Hence, if your floatcharge characteristic is
    //          given in the 2 V range you must set cells to 6.
    //
    //          The currents of the floatcharge are typically
    //          based on the capacity. That means the given currents
    //          must be multiplied with the capacity to get the real
    //          current for that accumulator. If the current is
    //          is measured across the 6 cells of the accumulator
    //          you must specifiy the capacity of the 6 cells.
    //          If two accumulators are in parallel, i.e. 12 cells
    //          and the current is measured for all 12 cells you
    //          must give the capacity of the 12 cells.
    //
    //          Contrary to the understanding currents where the
    //          current splits across parallel but will be the
    //          same going through serial consumers, it is
    //          different for the charging process. Parallel
    //          accumulators with same characteristics will
    //          take equal parts of the current (sharing as
    //          known from electrical consumers). However,
    //          a charging current will split across all
    //          cells that are in series. So the current is
    //          actually split over the cells as if they
    //          were in parallel.
    //
    //          To make this specification more clear look
    //          at the example of having 4 x 12 V accus
    //          two of them in series and the 2 series parallel
    //          to each other:
    //               |- 12V +|- 12V +|
    //          - __/        |        \__ + I
    //              \        |        /
    //               |- 12V +|- 12V +|
    //                  UL      UT
    //          You measure the float charge of the two lower accus
    //          UL and the two upper accus while the measured
    //          current I splits over all accus. The float charge
    //          characteristic is given per cell: each accu has
    //          6 cells (of approx. 2V). To keep it simple we assume
    //          each accu has a capacity of 200Ah.
    //          As you are measuring UL across 6 cells each (yes,
    //          actually 12 cells but 6 x (2 cell packs in parallel)
    //          you must specify 6 for the number of cells.
    //          As your current is measured for the total system,
    //          you must specify the capacity of the total system
    //          which is 800Ah. 
    //
    // \param fc a specification of the float charge characteristic
    //        containing 3 objects: current, voltage, SOC each of
    //        which contains an array of timestamps in hours
    //        and associated measurements of currents, voltages and
    //        SOCs. 
    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(fc, cells, capacity) {
        //logger.trace("FloatChargeCharacteristic::constructor");
	this.isOperational = false;
        this.resistance = [];
        this.soc = []; // state of charge
	// each accumulated ampere hour while charging must be multiplied by the appropriate
	// factor this.reduceAh[i]:
	this.reduceAh = []; // reduction factors for incoming ampere hours to real charge
	this.simplefAh = []; // reduction factors for incoming ampere hours to real charge

	// concat the time data, sort and make entries unique
        let tmp      = fc.current.hours.concat(fc.voltage.hours).unique();
        this.timeTags = tmp.concat(fc.SOC.hours).unique();
        this.timeTags.sort(function(a, b){return a - b});
        
        this.I  = interpolate(this.timeTags, fc.current.hours, fc.current.I);
        this.U  = interpolate(this.timeTags, fc.voltage.hours, fc.voltage.U);
        // capacity in percent
        this.CP = interpolate(this.timeTags, fc.SOC.hours,     fc.SOC.percent); 
        let cellCapacityScale = cells / capacity;
        this.R = this.U.map(function (u, idx) {
            return cellCapacityScale * u / this.I[idx];
        }.bind(this));

	this.simpleCalcReduceAh(cells, capacity);
	this.convResistanceToSOC(cells, capacity);
	this.calcResistanceToReduceAh(cells, capacity);
	
	console.log("i, I(i), U(i), CP(i)");
	this.I.map(function(i, idx) {
	    console.log(idx + ", " + i + ", " + this.U[idx] + ", " + this.CP[idx]);
	}.bind(this));
	console.log("i, R(i), SOC(i), fAh(i)");
	this.R.map(function(r, idx) {
	    console.log(idx + ", " + r + ", " + this.soc[idx] + ", " + this.reduceAh[idx]);
	}.bind(this));
	console.log("i, simplefAh(i)");
	this.simplefAh.map(function(f, idx) {
	    console.log(idx + ", " + f);
	});
		
	// FIXME: do we still need isOperational since getSOC calls can come in earlier
        // it may take a while till charge_characteristic.json is read
        if (this.resistance.length === 0 || this.soc.length === 0 || this.reduceAh.length === 0)
	    throw "Float charge characteristic is empty";
	else this.isOperational = true;
    }

    simpleCalcReduceAh(cells, capacity)
    {
	let subtract = 0;
	for (let i = 0; i < this.CP.length-1 ; i++) {
	    this.CP[i] = this.CP[i] - subtract;
	    let f = (this.CP[i+1] - this.CP[i]) /
		(50 * (this.I[i] + this.I[i+1]) * (this.timeTags[i+1] - this.timeTags[i]));
	    if (f <= 1)
		this.simplefAh.push(f);
	    else {
		let newCP = this.CP[i] +
		    (50 * (this.I[i] + this.I[i+1]) * (this.timeTags[i+1] - this.timeTags[i]))
		subtract = this.CP[i+1] - newCP;
	    }
	}
    }
    
    // \brief create function R -> SOC(R)
    convResistanceToSOC(cells, capacity) {	
        if (this.R.length > 0 && this.CP.length > 0) {
            this.resistance.push(this.R[0]);
            this.soc.push(this.CP[0]);

            for(let i = 1; i < this.R.length; ++i) {
                if(this.R[i-1] !== this.R[i])
                {
                    this.resistance.push(this.R[i]);
                    this.soc.push(this.CP[i]);
                }
		//else console.log("there are equal resistances");
            }
        }
    }

    // \detail When charging not all current goes into
    //         the battery, so accumulating current times
    //         time (Ah) will show more charge volume than
    //         reality. Reading the charge characteristic
    //         during a small duration deltaT=t_1-t_0 the
    //         current deltaI flow into the battery. 
    //         Ideally this would add a volume of
    //         deltaI * deltaT.
    //         However, the charge characteristic states
    //         that the SOC(t_1)-SOC(t_0) * nominalCapacity 
    //         = deltaSOC * nominalCapacity is less.
    //         Calculating the function
    //         (with C_n = nominalCapacity):
    //         C_n * deltaSOC/(deltaI * deltaT)
    //         is a factor function that needs to be
    //         multiplied to the accumulated volume.
    //         Using the injective function t -> R
    //         a function
    //         f(R):= C_n * deltaSOC(R)/(deltaI * deltaT)
    //         can be constructed.
    calcResistanceToReduceAh(cells, capacity) {

	// looking at i = 0:
	{
	    // change of CP around index i:
	    // 0.5*(this.CP[1] + this.CP[0]) - this.CP[0]
	    let gradCP = 0.5 * (this.CP[1] - this.CP[0]);
	    // gradCP must be multiplied by 0.01 to go from percentage to float
	    // and by capacity to reach to ampere hours
	    //
	    // ampere hours around index i:
	    // 0.5 * (this.I[0] + 0.5 * (this.I[1]+this.I[0])) * (0.5*(timeTags[1]+timeTags[0])-timeTags[0])
	    let ampHrs = 0.25 * (1.5*this.I[0] + 0.5*this.I[1]) * (this.timeTags[1] - this.timeTags[0]);
	    // ampHrs must be multiplied with the capacity as this.I and fc.current.I
	    // as the characteristic specifies the values per 2V cell.
	    // factor of increase of SOC compared to ingoing ampere hours:
	    // capacity * gradCP * 0.01 / (capacity * ampHrs)
	    let factor =  gradCP * 0.01 / ampHrs;
	    // resistance at index i: this.R[i]
	    this.reduceAh.push(factor);
	}
	for (let i = 1; i < this.timeTags.length-1; ++i)
	{
	    // looking at interval [i - 1/2; i + 1/2]:
	    // change of CP around index i:
	    // (0.5*(this.CP[i+1] + this.CP[i]) - 0.5*(this.CP[i] + this.CP[i-1]));
	    let gradCP = 0.5 * (this.CP[i+1] - this.CP[i-1]);
	    // gradCP must be multiplied by 0.01 to go from percentage to float
	    // and by capacity to reach to ampere hours
	    //
	    // ampere hours around index i:
	    // 0.5 * (0.5 * (this.I[i]+this.I[i-1]) + this.I[i]) * (timeTags[i] - 0.5*(timeTags[i]+timeTags[i-1]))
	    // + 0.5 * (this.I[i] + 0.5 * (this.I[i+1]+this.I[i])) * (0.5*(timeTags[i+1]+timeTags[i])-timeTags[i])
	    let ampHrs = 0.5 * ((0.75*this.I[i]+0.25*this.I[i-1]) * (this.timeTags[i]-this.timeTags[i-1])
				+ (0.75*this.I[i] + 0.25*this.I[i+1]) * (this.timeTags[i+1]-this.timeTags[i]));
	    // ampHrs must be multiplied with the capacity as this.I and fc.current.I
	    // as the characteristic specifies the values per 2V cell.
	    // factor of increase of SOC compared to ingoing ampere hours:
	    // capacity * gradCP * 0.01 / (capacity * ampHrs)
	    let factor =  gradCP * 0.01 / ampHrs;
	    // resistance at index i: this.R[i]
	    if (this.R[i-1] !== this.R[i])
		this.reduceAh.push(factor);
	    else
	    {
		let a = this.reduceAh[this.reduceAh.length-1];
		a = (a+factor) * 0.5;
		this.reduceAh[this.reduceAh.length-1] = a;
	    }
	}

	// looking at n = timeTags.length-1:
	{
	    let n = this.timeTags.length-1;
	    let gradCP = 0.5 * (this.CP[n] - this.CP[n-1]);
	    // gradCP must be multiplied by 0.01 to go from percentage to float
	    // and by capacity to reach to ampere hours
	    //
	    // ampere hours around index n:
	    // 0.5 * (0.5 * (this.I[n]+this.I[n-1]) + this.I[n]) * (timeTags[n] - 0.5*(timeTags[n]+timeTags[n-1]))
	    let ampHrs = 0.25 * (1.5*this.I[n]+0.5*this.I[n-1]) * (this.timeTags[n]-this.timeTags[n-1]);
	    // ampHrs must be multiplied with the capacity as this.I and fc.current.I
	    // as the characteristic specifies the values per 2V cell.
	    // factor of increase of SOC compared to ingoing ampere hours:
	    // capacity * gradCP * 0.01 / (capacity * ampHrs)
	    let factor =  gradCP * 0.01 / ampHrs;
	    // resistance at index i: this.R[i]
	    if (this.R[n-1] !== this.R[n])
		this.reduceAh.push(factor);
	    else
	    {
		// let a = this.reduceAh[this.reduceAh.length-1];
		// // FIXME make factor <= 1
		// a = (a+factor) * 0.5;
		// this.reduceAh[this.reduceAh.length-1] = a;
	    }
	}	
    }

    isApplicable(flow) {
	return this.isOperational && flow.getCurrent() > 0;
    }
    
    getSOC(flow) {
        let current = flow.getCurrent();
        let voltage = flow.getVoltage();
        console.log("actual current = " + current);
        console.log("actual voltage = " + voltage);
        if (! this.isApplicable(flow))
	    return -1;
        let atValue = flow.getResistance();
        let soc = 0;
	soc = interpolate(atValue, this.resistance, this.soc);
        soc = getPercentualSOC(soc);
        console.log("SOC = " + soc);
        return soc;
    }
}


class FloatVolume {
    // \param accumulator is a shared accumulator where any FloatVolume
    //        class managing it may change the max charge volume
    // \param chargeCharacteristic is either FloatChargeCharacteristic
    //        DischargeCharacteristic or RestingCharacteristic
    constructor(accumulator,
		chargeCharacteristic,
	        dischargeCharacteristic,
	        restingCharacteristic) {
	this.accumulator   = accumulator;
	this.chargeChar    = chargeCharacteristic;
	this.dischargeChar = dischargeCharacteristic;
	this.restingChar   = restingCharacteristic;
	this.characteristic = null;
	// FIXME: where to get flow from?
	//let flow = new Flow(0,0,0,0);
	this.integrator  = null; //new IntegralOverTime(flow, Date.now());

	// Algorithm:
	// depending on the current (<0, >0, =0)
	// 1. calculate estimated SOC and diff to the running integrator
	// 2. Maybe near 0A: eventually 3 estimations are running
	// 3. charge to discharge or discharge to charge must traverse
	//    through =0 state
	//    When =0 state is traversed from
	//    charge to =0 to discharge then akku capacity is corrected
	//    and the longer the current stays near =0 the more the
	//    integrator interval shrinks.
	//    When =0 is traversed from
	//    discharge to charge, same is done.

	this.lastEstimatedVolume = this.accumulator.getNominalCapacity() * 0.5;
	this.lastLowerIntegral = this.integrator.getLowerIntegral();
	this.lastUpperIntegral = this.integrator.getUpperIntegral();
	this.lowerVolume = this.lastEstimatedVolume;
	this.upperVolume = this.lastEstimatedVolume;
    }

    setCharacteristic(flow) {
	// TODO: several characteristic may be applicable e.g. for small currents
	if (this.chargeChar.isApplicable(flow)) {
	    this.characteristic = this.chargeChar;
	} else if (this.dischargeChar.isApplicable(flow)) {
	    this.characteristic = this.disChargeChar;
	}
    }    

    initIntegrator(flow, timeInSec) {
	// initialize integrator with first flow:
	this.integrator  = new Charge(flow, timeInSec);
	this.setCharacteristic(flow);
	let volume = this.accumulator.getCapacityInAh(this.characteristic.getSOC(flow));
	let rvolume = this.accumulator.getCapacityInAh(this.restingChar.getSOC(flow));
	if (this.restingChar.isApplicable(flow))
	{
	    // scale this.characteristic.SOC to restingChar
	}
	else
	{
	    // depending on flow.getCurrent() > or < 0 limit this.characteristic.SOC by this.restingChar.SOC
	}
	this.integrator.setOffset(volume);
    }

    // \param flow is of class Flow
    addFlow(flow, timeInSec) {
	// Initialization
	if (this.integrator === null) {
	    this.initIntegrator(flow, timeInSec);
	    return;
	}
	// Voltage/current based volume estimation:
	this.setCharacteristic(flow);
	let estimatedVolume = this.accumulator.getCapacityInAh(this.characteristic.getSOC(flow));

	// Integral volume:
	this.integrator.addCurrent(flow.getCurrent(), timeInSec);
	
	// Synchronisation of two volume estimation methods:
	// FIXME: what is the final volume now?
	if (estimatedVolume > this.integrator.getUpperIntegral()) {
	    // reduce capacity by 5%
	    this.accumulator.setCapacity(this.accumulator.getCapacity() * 0.95);
	    console.log("Correction - accu capacity reduced by 5%");
	} else if (estimatedVolume < this.integrator.getLowerIntegral()) {
	    this.integrator.setOffset(estimatedVolume - this.integrator.getLowerIntegral());
	    console.log("Correction - integration offset reduced by " + estimatedVolume - this.integrator.getLowerIntegral());
	}
	this.volume = (estimatedVolume + this.integrator.getIntegral()) * 0.5;
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
    }

    isApplicable(flow) {
	return flow.getCurrent() < 0;
    }

    getSOC(flow) {
        if (! isApplicable(flow)) return 0;
        let soc = 0;
        return getPercentualSOC(soc);
    }


}


    // // FIXME: move capacity by temp correction in other class
    // this.capacityByTemp = null;
    // this.actualCTFactor = 1;
    // this.capacityByTemp = cc.capacityByTemp;
    // setCapacityByTemperature(actualTempInC);

    // setCapacityByTemperature(actualTempInC) {
    //  this.actualCTFactor = interpolate(actualTempInC,
    //                       this.capacityByTemp.celcius
    //                       this.capacityByTemp.percent);
    // }


// nach einer Tiefentladung unbedingt voll laden!!!

// Betriebseigenschaften
// Entladetiefe (DOD) max. 80% (Ue= 1,91 V/Zelle für Entladezeiten >10 h; 1,74 V/Zelle für 1 h)
// Tiefentladungen auf mehr als 80 % DOD sind zu vermeiden.
// Ladestrom ist unbegrenzt, der Mindestladestrom sollte I10 betragen.
// Ladespannung Zyklenbetriebauf 2,30 V bis 2,40 V pro Zelle beschränkt, Gebrauchsanweisung beachten
// Ladeerhaltungsspannung/ nicht zyklischer Betrieb 2,25 V/Zelle
// keine Anpassung der Ladespannung notwendig, sofern die Batterietemperatur im Monatsdurchschnitt zwischen 10 °C und 45 °C beträgt, ansonsten U/T = -0.003 V/Zelle pro K
// Vollladung auf 100 % innerhalb des Zeitraums zwischen 1 bis 4 Wochen
// IEC 61427 Zyklen >3000 Zyklen
// Batterietemperatur -20 °C bis 45 °C, empfohlener Temperaturbereich 10 °C bis 30°C Selbstentladungca. 2 % pro Monat bei 20 °C


// \detail Extension for VEdeviceClass making available
//         the lower and upper voltages for accumulators
//         in series: i.e. add object 'topVoltage'
class VEdeviceSerialAccu extends VEdeviceClass {

    constructor(cmd) {
        super();

        // Demonstration how to create additional objects
        // and how to make them fire on update events:
        // map an additional component topVoltage
        let bmvdata = this.update();
        bmvdata.topVoltage = this.createObject(0.001,  "V", "Top Voltage");
        // Make midVoltage and upperVoltage fire topVoltage's callback "on"
        // if there is a change in these dependencies
        bmvdata.upperVoltage.on.push(
            (newValue, oldValue, packageArrivalTime, key) => {
                bmvdata.topVoltage.newValue = newValue - bmvdata.midVoltage.value;
                this.rxtx.updateCacheObject('topVoltage', bmvdata.topVoltage);
            }
        );
        bmvdata.midVoltage.on.push(
            (newValue, oldValue, packageArrivalTime, key) => {
                bmvdata.topVoltage.newValue = bmvdata.upperVoltage.value - newValue;
                this.rxtx.updateCacheObject('topVoltage', bmvdata.topVoltage);
            }
        );
        // bmvdata.topSOC          = createObject(1,  "%", "Top SOC", {'formatter' : function() 
        // {
        //      let topSOC    = estimate_SOC(bmvdata.topVoltage.formatted());
        //      topSOC = Math.round(topSOC * 100) / 100;
        //      return topSOC;
        // }});
        // bmvdata.bottomSOC      = createObject(1,  "%", "Bottom SOC", {'formatter' : function() 
        // {
        //      let bottomSOC = estimate_SOC(bmvdata.midVoltage.formatted());
        //      bottomSOC = Math.round(bottomSOC * 100) / 100;
        //      return bottomSOC;
        // }});
    }
}

class Accumulator {
    constructor(amperHours) {
	this.maxCapacityInAh = amperHours;
        this.capacityInAh    = amperHours; // capacity declines with time
    }

    setCapacity(c) {
	// TODO: later possibly allow decreasing capacityInAh only
	//if (c < this.capacityInAh) this.capacityInAh = c;
	console.log("Change Accu Capacity to " + c);
	this.capacityInAh = c;
    }

    getSOC(amperHours) {
        return 100.0 * amperHours / this.capacityInAh; // * 100 => convert to percentage
    }

    getNominalCapacity() {
        return this.maxCapacityInAh;
    }

    getCapacity() {
        return this.capacityInAh;
    }

    // \param soc in percent i.e. in [0; 100]
    getCapacityInAh(soc) {
        return this.capacityInAh * soc * 0.01;
    }
}

const scaleSecondsToHours = 1 / (60 * 60);

// \class Battery Management System
class BMS extends VEdeviceSerialAccu {
    constructor() {
        super();

	let bmvdata = this.update();
	this.ntuFactorCurrent  = bmvdata.batteryCurrent.nativeToUnitFactor;
	this.ntuFactorUVoltage = bmvdata.topVoltage.nativeToUnitFactor;
	this.ntuFactorLVoltage = bmvdata.midVoltage.nativeToUnitFactor;

	// device limitations of inverter and charger
	// TODO: read min/max from file
	// Lead Accu: ladeschlussspannung = 2.42V/Zelle -> 14.52
	//           Ladeerhaltungspann. = 2.23V/Zelle
	//           Entladeschlusspannung = 1,75V/Zelle -> 10.5V

        this.lowerFlow   = new Flow(-150.0, 45.0, 10.5, 14.52);
        this.upperFlow   = new Flow(-150.0, 45.0, 10.5, 14.52);

        // accu characteristics
	// TODO: read 200Ah from file
        // FIXME: name bottom + top for accus for flows, float volumes etc - better construct for top and bottom separately
	//        and have two instances...
	this.bottomAccumulator = new Accumulator(2 * 200); // 2 accus in parallel like one 400Ah accu
        this.topAccumulator = new Accumulator(2 * 200); // 2 accus in parallel like one 400Ah accu

	const filename = __dirname + '/charge_characteristic.json';
        fs.readFile(filename, 'utf8', (err, data) => {
            if (err) {
                //logger.error(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
                console.log(`cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
                console.log(err.stack);
            } else {
                //logger.debug("Parse configuration (JSON format)");
                // charge characteristics data
                let cc = JSON.parse(data);
                let fc = cc.floatcharge;

		// The measured Voltage in this process nominal 12 V for the upper and nominal 12 V
		// for the lower pack. The measured current splits across all accumulators, the
		// 2 lower and 2 upper, i.e. across 800 Ah.
		this.lowerFloatC   = new FloatChargeCharacteristic(fc, 6, this.accumulator.getNominalCapacity());
		this.upperFloatC   = new FloatChargeCharacteristic(fc, 6, this.accumulator.getNominalCapacity());
            }
        });

        this.registerListener('midVoltage', this.setMidVoltage.bind(this));
        this.registerListener('topVoltage', this.setTopVoltage.bind(this));

        this.lowerRestingC = new RestingCharacteristic();
        this.upperRestingC = new RestingCharacteristic();
        // FIXME: temporary use RestingChara. until DischargeChar is defined
        this.lowerDischargeC = new RestingCharacteristic();
        this.upperDischargeC = new RestingCharacteristic();

	//this.top|bottomFloatVolume = new FloatVolume(this.bottomAccumulator, this.lowerFloatC, this.lowerDischargeC, this.lowerRestingC);

        //this.lowerIncCapacity = new IntegralOverTime(this.lowerFlow.getCurrent());
        //this.upperIncCapacity = new IntegralOverTime(this.upperFlow.getCurrent());

        // must be registered last because lower|upperFlow and
        // lower|upperIncCapacity must be instantiated before
        this.registerListener('batteryCurrent', this.setCurrent.bind(this));

	// hide useless parameters in BMV display
	this.setShowTimeToGo(0);
	this.setShowTemperature(0);
	this.setShowPower(0);
	this.setShowConsumedAh(0);
    }

    setMidVoltage(newVoltage, oldVoltage, timeStamp, key) {
	let voltage = newVoltage * this.ntuFactorLVoltage; // => in volts
        this.lowerFlow.setVoltage(voltage);

	// avoid deep discharge
	if (this.lowerFlow.getVoltage() < 12.0 &&
	    this.lowerFlow.getCurrent() < 1.0) {
	    console.log("Deep discharge bottom!!!");
	    // TODO: set relay to switch to grid
	}

	// Overcharge cannot be controlled (no electronic switches).
	// It should be handled by the charger and battery balancer
	// the later of which balances the voltage (exactly) between
	// the two blocks in series.
    }

    setTopVoltage(newVoltage, oldVoltage, timeStamp, key) {
	let voltage = newVoltage * this.ntuFactorUVoltage; // => in volts
	this.upperFlow.setVoltage(voltage);

    	// avoid deep discharge
	if (this.upperFlow.getVoltage() < 12.0 &&
	    this.upperFlow.getCurrent() < 1.0) {
	    console.log("Deep discharge top!!!");
	    // TODO: set relay to switch to grid
	}

	// Overcharge cannot be controlled (no electronic switches).
	// It should be handled by the charger and battery balancer
	// the later of which balances the voltage (exactly) between
	// the two blocks in series.
    }

    // \param newCurrent, oldCurrent, timeStamp as string (need conversion to numbers)
    setCurrent(newCurrent, oldCurrent, timeStamp, key) {
	// TODO: overcurrent handling: if extracted current > 150 switch to mains (maybe 10% earlier to not destroy the fuse)

	// see explanation to class FloatChargeCharacteristic:
	// The current is measured across the 24V, i.e. it must be split
	// across the lower and upper accus packs of 12V, i.e. divided by 2:
	let current = newCurrent * 0.5 * this.ntuFactorCurrent; // => SI units
        this.lowerFlow.setCurrent(current);
        this.upperFlow.setCurrent(current);
	let time = timeStamp * 0.001; // converts from milliseconds to SI (seconds)
	this.lowerIncCapacity.add(this.lowerFlow.getCurrent(), time);
        this.upperIncCapacity.add(this.upperFlow.getCurrent(), time);

        let lCurrent = this.lowerFlow.getCurrent();
	let soc = 0;
        if (Math.abs(lCurrent) < 0.01) { // absolute less than 10mA
            soc = this.lowerRestingC.getSOC(this.lowerFlow);
            let lowerC = this.accumulator.getCapacityInAh(soc) + this.lowerIncCapacity.getLowerIntegral() * scaleSecondsToHours;
            let upperC = this.accumulator.getCapacityInAh(soc) + this.lowerIncCapacity.getUpperIntegral() * scaleSecondsToHours;
            console.log("lower C(rest): [" + lowerC + ", " + upperC + "]");
        }
        if (lCurrent > 0) {
            soc = this.lowerFloatC.getSOC(this.lowerFlow);
        }
        else if (lCurrent < 0) {
            soc = this.lowerDischargeC.getSOC(this.lowerFlow);
        }
    }

    getLowerSOC() {
        return this.lowerFloatC.getSOC(this.lowerFlow);
    }

    getUpperSOC() {
        return this.upperFloatC.getSOC(this.upperFlow);
    }

    // TODO: register function with two voltages which switches relay
    //       to mains if undervoltage

}


module.exports.BMSInstance = new BMS();

