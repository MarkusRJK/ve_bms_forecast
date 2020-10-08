var VEdeviceClass = require( 've_bms_forecast' ).VitronEnergyDevice;
const interpolate = require('everpolate').linear;
var fs = require('fs');
const Math = require('mathjs');

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
    return typeof value === 'number'; // && isFinite(value);
}

function getInRangeSOC(soc) {
    if (soc < 0) return 0;
    else if (soc > 100) return 100;
    else return soc;    
}

class Flow {

    constructor() {
        this.actualVoltage = 0;
        this.actualCurrent = 0;
    }
    
    setCurrent(current) {
        let I = parseFloat(current);
        console.log("I = " + I);
        // my charger can max deliver 45A
        // FIXME: make configurable and use n2F conversion
        if (! isNaN(I) && I <= 45000 && I > -150000) {
            this.actualCurrent = I / 1000.0;
        }
    }

    getCurrent() {
        return this.actualCurrent;
    }

    setVoltage(voltage) {
        let U = parseFloat(voltage);
        console.log("U = " + U);
        if (! isNaN(U) && U <= 15000 && U >= 9000) {
            this.actualVoltage = U / 1000.0;
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
    // Gel Battery:  
    // 12.0V 12.00 11.76 11.98  0%
    // 12.2V 12.25 12.00        25%
    // 12.3V 12.40 12.30 12.40  50%
    // 12.5V 12.60 12.55        75%
    // 12.8V 12.80 12.78 12.80 100%
    //               ^ am zuverlaessigsten
    constructor() {
        this.voltage = [11.98, 12.25, 12.40, 12.55, 12.80];
        this.soc     = [0,     25,    50,    75,    100];
    }

    getSOC(flow) {
        let soc = interpolate(flow.getVoltage(), this.voltage, this.soc);
        return getInRangeSOC(soc);
    }
}


class IntegralOverTime
{
    constructor(value, timeStamp) {
        this.integral = 0;
        this.lowerIntegral = 0;
        this.upperIntegral = 0;
        this.firstValue = value;
        this.lastValue  = value;
        if (timeStamp !== undefined && timeStamp !== null)
            this.lastTime = timeStamp;
        else
            this.lastTime = new Date(); // FIXME: new Date in constructor causes long first duration
        this.firstTime  = this.lastTime;
        this.isAscending = false;
        this.isDescending = false;
    }

    add(value, timeStamp)
    {
        let currentTime = 0;
        if (timeStamp !== undefined && timeStamp !== null)
            currentTime = timeStamp;
        else
            currentTime = new Date(); // time in milliseconds since epoch
        const duration = currentTime - this.lastTime; // milliseconds
        this.lastTime = currentTime;
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

    getValue()
    {
        return this.integral;
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

    getLowerValue()
    {
        return this.lowerIntegral;
    }

    getUpperValue()
    {
        return this.upperIntegral;
    }
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
                // charge characteristics data
                let cc = JSON.parse(data);
                let fc = cc.floatcharge;

                // concat the time data, sort and make entries unique
                let tmp      = fc.current.hours.concat(fc.voltage.hours).unique();
                let timeTags = tmp.concat(fc.SOC.hours).unique();
                timeTags.sort(function(a, b){return a - b});
                
                let I  = interpolate(timeTags, fc.current.hours, fc.current.I);
                let U  = interpolate(timeTags, fc.voltage.hours, fc.voltage.U);
                // capacity in percent
                let CP = interpolate(timeTags, fc.SOC.hours,     fc.SOC.percent); 

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

    getSOC(flow) {
        let current = flow.getCurrent();
        let voltage = flow.getVoltage();
        console.log("actual current = " + current);
        console.log("actual voltage = " + voltage);
        if (this.actualCurrent <= 0) return 0;
        let atValue = flow.getResistance();
        let soc = 0;
        // it may take a while till charge_characteristic.json is read
        if (this.resistance.length > 0 && this.soc.length > 0) 
            soc = interpolate(atValue, this.resistance, this.soc);
        soc = getInRangeSOC(soc);
        console.log("SOC = " + soc);
        return soc;
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

    getSOC(flow) {
        if (flow.getCurrent() >= 0) return 0;
        let soc = 0;
        return getInRangeSOC(soc);
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
        this.capacityInAh = amperHours;
    }

    getSOC(amperHours) {
        return amperHours / this.capacityInAh * 100.0;
    }

    getNominalCapacity() {
        return this.capacityInAh;
    }

    // \param soc in percent i.e. in [0; 100]
    getCapacityInAh(soc) {
        return this.capacityInAh * soc / 100;
    }
}

// \class Battery Management System
class BMS extends VEdeviceSerialAccu {
    constructor() {
        super();
        // accu characteristics
        this.lowerFlow   = new Flow();
        this.upperFlow   = new Flow();

        this.registerListener('midVoltage',
                              this.lowerFlow.setVoltage.bind(this.lowerFlow));
        this.registerListener('topVoltage',
                              this.upperFlow.setVoltage.bind(this.upperFlow));

        this.accumulator   = new Accumulator(400)

        this.lowerFloatC   = new FloatChargeCharacteristic(6, this.accumulator.getNominalCapacity());
        this.upperFloatC   = new FloatChargeCharacteristic(6, this.accumulator.getNominalCapacity());
        this.lowerRestingC = new RestingCharacteristic();
        this.upperRestingC = new RestingCharacteristic();
        // FIXME: temporary use RestingChara. until DischargeChar is defined
        this.lowerDischargeC = new RestingCharacteristic();
        this.upperDischargeC = new RestingCharacteristic();

        this.lowerCapacity = new IntegralOverTime(this.lowerFlow.getCurrent());
        this.upperCapacity = new IntegralOverTime(this.upperFlow.getCurrent());

        // must be registered last because lower|upperFlow and
        // lower|upperCapacity must be instantiated
        this.registerListener('batteryCurrent',
                              this.setCurrent.bind(this));
    }

    setCurrent(newCurrent, oldCurrent, timeStamp, key) {
        this.lowerFlow.setCurrent(newCurrent);
        this.upperFlow.setCurrent(newCurrent);
        this.lowerCapacity.add(newCurrent, timeStamp);
        this.upperCapacity.add(newCurrent, timeStamp);

        let lCurrent = this.lowerFlow.getCurrent();
        const scale = 1000 * 1000 * 60 * 60;
        if (Math.abs(lCurrent) < 0.01) {
            let soc = this.lowerRestingC.getSOC(this.lowerFlow);
            let lowerC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getLowerValue() / scale;
            let upperC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getUpperValue() / scale;
            console.log("lower C(rest): [" + lowerC + ", " + upperC + "]");
        }
        if (lCurrent > 0) {
            let soc = this.lowerFloatC.getSOC(this.lowerFlow);
            let lowerC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getLowerValue() / scale;
            let upperC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getUpperValue() / scale;
            console.log("lower C(float): [" + lowerC + ", " + upperC + "]");
        }
        else if (lCurrent < 0) {
            let soc = this.lowerDischargeC.getSOC(this.lowerFlow);
            let lowerC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getLowerValue() / scale;
            let upperC = this.accumulator.getCapacityInAh(soc) + this.lowerCapacity.getUpperValue() / scale;
            console.log("lower C(discharge): [" + lowerC + ", " + upperC + "]");
        }
    }

    getLowerSOC() {
        return this.lowerFloatC.getSOC(this.lowerFlow);
    }

    getUpperSOC() {
        return this.upperFloatC.getSOC(this.upperFlow);
    }
}


module.exports.BMSInstance = new BMS();

