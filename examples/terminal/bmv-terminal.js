//
// BMV
//

'use strict';

const Math = require('mathjs');
var term = require( 'terminal-kit' ).terminal;
// ES6: import * as vedirect from 've_bms_forecast'
const vedirect = require( 've_bms_forecast' ).VitronEnergyDevice;

var fs = require('fs');
var log4js = require('log4js');
//var config_file = fs.createWriteStream(__dirname + '/config.json', {flags: 'w'});

log4js.configure({
  appenders: {
    everything: { type: 'file', filename: '/var/log/debug.log' }
  },
  categories: {
    default: { appenders: [ 'everything' ], level: 'debug' }
  }
});

const logger = log4js.getLogger();
logger.level = 'debug';

var avgBaseCurrentLowVoltage = 660; // mA
var inverterBaseCurrent = 5590 - avgBaseCurrentLowVoltage; // mA

var bmvdata = {};


function terminate()
{
    term.grabInput( false ) ;
    setTimeout( function() { process.exit() } , 100 ) ;
}

term.clear();

function getStoredAh()
{
    if (bmvdata.absorbedEnergy.value === null) return null;
    if (bmvdata.dischargeEnergy.value === null) return null;
    // FIXME: consumedAh depends on the voltage => use IntegrateOverTime!!!
    // do not use formatted(); value yields in better precision
    let consumedAh = bmvdata.absorbedEnergy.value - bmvdata.dischargeEnergy.value;
    consumedAh /= 2400; // multiply value by 0.01 to get kWh and divide by 24V to get Ah
    return consumedAh;
}

function getAccumulatedSOC(soc, deltaAhSinceLast)
{
    if (bmvdata.capacity.value === undefined
	|| bmvdata.capacity.value === null
	|| bmvdata.capacity.value === 0)
    {
	logger.warn("getAccumulatedSOC: Capacity missing");
	return null;
    }
    if (soc === undefined)
    {
	logger.warn("getAccumulatedSOC: SOC missing");
	return null;
    }
    soc = soc * 0.01; // convert from % to float
    let lastAh = soc * bmvdata.capacity.formatted();
    let currentAh = lastAh + deltaAhSinceLast;
    let socNew = Math.max(Math.min(currentAh / bmvdata.capacity.formatted() * 100.0, 100.0), 0.0);
    if (deltaAhSinceLast != 0)
	logger.debug("deltaAhsincelast: " + deltaAhSinceLast
		     + "  soc: " + soc
		     + "  lastAH: " + lastAh
		     + "  currentAh: " + currentAh
		     + "  new soc: " + socNew);
    return socNew;
}

var lastTopSOC;
var lastBottomSOC;
var lastStoredAh;

function getBestEstimateTopSOC(current)
{
    let deltaAhSinceLast = getStoredAh();
    if (deltaAhSinceLast === null)
    {
	deltaAhSinceLast = lastStoredAh;
	logger.warn("Stored Ah not yet available");
    }
    let isAccumulating = true;
    // positive if the battery got charged, negative if it got discharged
    if (deltaAhSinceLast !== null && lastStoredAh !== null && lastStoredAh !== undefined)
	deltaAhSinceLast -= lastStoredAh;
    else
    {
	if (deltaAhSinceLast === null) logger.warn("deltaAhSinceLast is null");
	if (lastStoredAh === null) logger.warn("lastStoredAh is null");
	if (lastStoredAh === undefined) logger.warn("lastStoredAh is undefined");

	deltaAhSinceLast = 0;
	isAccumulating = false;
	logger.warn("Cannot accumulate");
    }
    if (deltaAhSinceLast != 0)
	logger.debug("lastTopSOC and deltaAhSinceLast = " + lastTopSOC + "  " + deltaAhSinceLast);
    let topSOC = getAccumulatedSOC(lastTopSOC, deltaAhSinceLast);
    logger.debug("topSOC = " + topSOC);
    let voltage = 1.955 * 6;
    if (bmvdata.topVoltage.value !== null) voltage = bmvdata.topVoltage.formatted();
    if (topSOC === null)
	topSOC = estimate_SOC(voltage);
    //logger.info("current: " + current + "  maxNullcurrentth: " + maxNullCurrentThreshold);
    if (Math.abs(current) < maxNullCurrentThreshold
        || lastTopSOC === undefined || lastStoredAh === undefined || lastStoredAh === null
        || topSOC === 0 || topSOC >= 100)
    {
	lastTopSOC = estimate_SOC(voltage);
	lastStoredAh = getStoredAh();
	if (isAccumulating && topSOC != lastTopSOC)
	    logger.debug("diff between accumulated top SOC (" + topSOC + ") and null-current SOC ("
		     + lastTopSOC + ") is: " + (topSOC - lastTopSOC));
	topSOC = lastTopSOC;
    }
    return topSOC;
}
	
function getBestEstimateBottomSOC(current)
{
    let deltaAhSinceLast = getStoredAh();
    if (deltaAhSinceLast === null)
    {
	deltaAhSinceLast = lastStoredAh;
	logger.warn("Stored Ah not yet available");
    }
    let isAccumulating = true;
    // positive if the battery got charged, negative if it got discharged
    if (deltaAhSinceLast !== null && lastStoredAh !== null && lastStoredAh !== undefined)
	deltaAhSinceLast -= lastStoredAh;
    else
    {
	if (deltaAhSinceLast === null)      logger.warn("deltaAhSinceLast is null");
	if (lastStoredAh     === null)      logger.warn("lastStoredAh is null");
	if (lastStoredAh     === undefined) logger.warn("lastStoredAh is undefined");

	deltaAhSinceLast = 0;
	isAccumulating = false;
	logger.warn("Cannot accumulate");
    }
    let bottomSOC = getAccumulatedSOC(lastBottomSOC, deltaAhSinceLast)
    let voltage = 1.955 * 6;
    if (bmvdata.midVoltage.value !== null) voltage = bmvdata.midVoltage.formatted();
    if (bottomSOC === null)
	bottomSOC = estimate_SOC(voltage);
    //logger.info("current: " + current + "  maxNullcurrentth: " + maxNullCurrentThreshold);
    if (Math.abs(current) < maxNullCurrentThreshold
        || lastBottomSOC === undefined || lastStoredAh === undefined || lastStoredAh === null
        || bottomSOC === 0 || bottomSOC >= 100)
    {
	lastBottomSOC = estimate_SOC(voltage);
	lastStoredAh = getStoredAh();
	if (isAccumulating && bottomSOC != lastBottomSOC)
	    logger.debug("diff between accumulated bottom SOC (" + bottomSOC + ") and null-current SOC ("
		     + lastBottomSOC + ") is: " + (bottomSOC - lastBottomSOC));
	bottomSOC = lastBottomSOC;
    }
    return bottomSOC;
}
	
var menu1 = "(A)larm (B)oot (D)ownload Cfg (L)og current (P)ing (R)elay"
var menu2 = "(S)OC (T)oggle screen (U)pload Cfg (V)ersion (Ctrl-C) Exit";
var minSOC;

function displayCurrentAndHistory() {
    var clearStr = "                                              ";
    var v1 = 2;  // first vertical position
    var v2 = 30; // second vertical position
    var v3 = 56; // third  vertical position
    var h  = 2;

    term.moveTo(v1, h, "BMV type: ");
    term.brightBlue(bmvdata.productId.formatted());
    term.moveTo(v2, h, "%s: %f", bmvdata.version.shortDescr, bmvdata.version.formatted() );
    let d = new Date();
    term.moveTo(v3, h++, "Time: %s", d.toUTCString() );

    h++;
    term.moveTo(v1 , h,   clearStr) ;
    term.moveTo(v1,  h,   "%s: ", bmvdata.alarmState.shortDescr);
    if (bmvdata.alarmState.value === "OFF") {
	term.green(bmvdata.alarmState.value);
    }
    else {
	term.brightRed(bmvdata.alarmState.value);
    }
    term.moveTo(v2,  h,   "%s: %s", bmvdata.relayState.shortDescr, bmvdata.relayState.value);
    term.moveTo(v3 , h++, "Accu Alarm: (%d) ", bmvdata.alarmReason.value) ;
    var alarmText = bmvdata.alarmReason.formatted();
    if (bmvdata.alarmReason.value == 0) {
        term.green( alarmText ) ;
    } else {
        term.brightRed( alarmText ) ;
    } 

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v2, h,   "%s: %s", bmvdata.lowVoltageAlarms.shortDescr, bmvdata.lowVoltageAlarms.formattedWithUnit());
    term.moveTo(v3, h++, "%s: %s", bmvdata.highVoltageAlarms.shortDescr, bmvdata.highVoltageAlarms.formattedWithUnit());

    term.white.moveTo(v1, h, clearStr);
    term.moveTo(v1, h,   "%s: %s", bmvdata.minVoltage.shortDescr, bmvdata.minVoltage.formattedWithUnit());
    term.moveTo(v2, h, bmvdata.upperVoltage.shortDescr + ": ") ;
    if (bmvdata.batteryCurrent.value === 0) {
        term.blue( bmvdata.upperVoltage.formattedWithUnit() ) ;
    }
    if (bmvdata.batteryCurrent.value < 0) {
        term.yellow( bmvdata.upperVoltage.formattedWithUnit() ) ;
    }
    if (bmvdata.batteryCurrent.value > 0) {
        term.green( bmvdata.upperVoltage.formattedWithUnit() ) ;
    }
    term.moveTo(v3, h++, "%s: %s", bmvdata.maxVoltage.shortDescr, bmvdata.maxVoltage.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h,   "%s: %s", bmvdata.minAuxVoltage.shortDescr, bmvdata.minAuxVoltage.formattedWithUnit());

    term.moveTo(v2, h,   "%s: %s   " , bmvdata.midVoltage.shortDescr, bmvdata.midVoltage.formattedWithUnit() ) ;

    term.moveTo(v3, h++, "%s: %s", bmvdata.maxAuxVoltage.shortDescr, bmvdata.maxAuxVoltage.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v2, h++, "%s: %s   " , bmvdata.topVoltage.shortDescr, bmvdata.topVoltage.formattedWithUnit()) ;

    term.moveTo(v1, h, clearStr) ;

    let current = maxNullCurrentThreshold + 1;
    if (bmvdata.batteryCurrent.value !== null && bmvdata.batteryCurrent.value !== undefined)
	current = bmvdata.batteryCurrent.formatted();

    let topSOC    = getBestEstimateTopSOC(current).toFixed(1);
    let bottomSOC = getBestEstimateBottomSOC(current).toFixed(1);
    
    if (topSOC && bottomSOC)
	minSOC = Math.min(topSOC, bottomSOC);

    if ((isNaN(bmvdata.stateOfCharge.value)) || bmvdata.stateOfCharge.value * 0.1 > 100
        || bmvdata.stateOfCharge.value * 0.1 < 0)
	if (minSOC) vedirect.setStateOfCharge(minSOC);

    if (minSOC && Math.abs(bmvdata.stateOfCharge.value * 0.1 - minSOC) >=1)
    {
	vedirect.setStateOfCharge(minSOC);
    }
    term.moveTo(v1, h,     "%s: %s %  " , "SOC lower", bottomSOC);
    term.moveTo(v2, h,     "SOC: %s  " , bmvdata.stateOfCharge.formattedWithUnit() ) ;
    term.moveTo(v3, h++,   "%s: %s %  " , "SOC top", topSOC);

    term.moveTo(v1, h, clearStr) ;
    term.moveTo(v2, h++, "%s: %s", bmvdata.midDeviation.shortDescr, bmvdata.midDeviation.formattedWithUnit());

    term.moveTo(v1, h, clearStr) ;
    term.moveTo(v1, h, "Current %s   " , bmvdata.batteryCurrent.formattedWithUnit() ) ;
    term.moveTo(v2, h++, "Power: %s", bmvdata.instantPower.formattedWithUnit());

    //term.moveTo(v1, h, clearStr) ;
    //term.moveTo(v1, h++, "%s: %s   " , bmvdata.auxVolt.shortDescr, bmvdata.auxVolt.formattedWithUnit() ) ;

    // bmvdata.VS, bmvdata.I2, bmvdata.V2, bmvdata.SOC2
    //term.moveTo( 24 ,16 , "                                "); 
    //term.moveTo( 24 ,16 , "Line: %s", bmvdata.line);

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "Dischg deep: %s", bmvdata.deepestDischarge.formattedWithUnit());
    term.moveTo(v2, h, "last: %s", bmvdata.maxAHsinceLastSync.formattedWithUnit());
    term.moveTo(v3, h++, "avg.: %s", bmvdata.avgDischarge.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "%s: %s", bmvdata.chargeCycles.shortDescr, bmvdata.chargeCycles.formattedWithUnit());
    term.moveTo(v2, h, "%s: %s", bmvdata.fullDischarges.shortDescr, bmvdata.fullDischarges.formattedWithUnit());
    term.moveTo(v3, h++, "%s: %s", bmvdata.noAutoSyncs.shortDescr, bmvdata.noAutoSyncs.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h, "%s: %s", bmvdata.drawnAh.shortDescr, bmvdata.drawnAh.formattedWithUnit());
    term.moveTo(v2, h, "%s: %s", bmvdata.dischargeEnergy.shortDescr, bmvdata.dischargeEnergy.formattedWithUnit());
    term.moveTo(v3, h++, "%s: %s", bmvdata.absorbedEnergy.shortDescr, bmvdata.absorbedEnergy.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.consumedAh.shortDescr, bmvdata.consumedAh.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h,   "%s: %s", bmvdata.timeSinceFullCharge.shortDescr, bmvdata.timeSinceFullCharge.formattedWithUnit());
    term.moveTo(v3, h++, "%s: %s", bmvdata.timeToGo.shortDescr, bmvdata.timeToGo.formattedWithUnit());

    h++; // empty line
    term.moveTo(v1, h++, menu1);
    term.moveTo(v1, h++, menu2);

    term.moveTo( 0 , 0 , "") ;
}

function displayConfiguration() {
    var clearStr = "                                              ";
    var v1 = 2;  // first vertical position
    var v2 = 30; // second vertical position
    var v3 = 56; // third  vertical position
    var h  = 2;

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.capacity.shortDescr, bmvdata.capacity.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.chargedVoltage.shortDescr, bmvdata.chargedVoltage.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.tailCurrent.shortDescr, bmvdata.tailCurrent.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.chargedDetectTime.shortDescr, bmvdata.chargedDetectTime.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.peukertCoefficient.shortDescr, bmvdata.peukertCoefficient.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.currentThreshold.shortDescr, bmvdata.currentThreshold.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.timeToGoDelta.shortDescr, bmvdata.timeToGoDelta.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.relayLowSOC.shortDescr, bmvdata.relayLowSOC.formattedWithUnit());

    term.moveTo(v1, h,   clearStr);
    term.moveTo(v1, h++, "%s: %s", bmvdata.relayLowSOCClear.shortDescr, bmvdata.relayLowSOCClear.formattedWithUnit());

    h++; // empty line
    term.moveTo(v1, h++, menu1);
    term.moveTo(v1, h++, menu2);

    term.moveTo( 0 , 0 , "") ;
}


// Dispersion parameter
class StatisticObject {
    constructor() {
	this.reset();
    }

    reset() {
        this.min = 32000;
        this.max = 0;
        this.runningAvg = 0;
        this.runningVar = 0;
        this.counter = 0;
    }

    // currents must be integer and in mA
    update(value) {
        var v = parseInt(value);
        this.min = Math.min(this.min, v);
        this.max = Math.max(this.max, v);
        this.runningAvg = v + this.runningAvg;
        this.counter++;
        var avg = Math.floor(this.runningAvg / this.counter);
        this.runningVar = this.runningVar + Math.square(v - avg);
    }
    
    print(log)
    {
	var minimum   = 0;
        var average   = 0;
        var varianz   = 0;
        if (this.counter != 0)
        {
	    minimum   = this.min;
            average   = Math.floor(this.runningAvg / this.counter);
            varianz   = Math.floor(this.runningVar / this.counter);
        }
        log.write(
              minimum + '\t'
	    + average  + '\t'
	    + this.max + '\t'
	    + varianz);
    }
}

var chargeCurrent = new StatisticObject();
var drawCurrent   = new StatisticObject();

var date = new Date();
var hour = date.getHours();
//var current_log = fs.createWriteStream(__dirname + '/current.log', {flags: 'a'});
var current_log = fs.createWriteStream('/var/log/current.log', {flags: 'a'});

//Zeitreihen
function log_buckets(current)
{
    var date = new Date();
    var newHour = date.getHours();
    if (newHour !== hour)
    {
	if (newHour == 0)
	{
	   current_log.write(date.toLocaleString());
	   current_log.write('\n');
	}
        current_log.write(hour + '\t');
        chargeCurrent.print(current_log);
        current_log.write('\t');
        drawCurrent.print(current_log);
        current_log.write('\n');
        chargeCurrent.reset();
        drawCurrent.reset();
    }
    hour = newHour;
    if (current >= 0)
    {
        chargeCurrent.update(current);
    }
    else
    {
	current = -current;
        drawCurrent.update(current);
    }
}


// input total current and lower or upper voltage of battery array (must be around 12V)


var nullCounter = 0;
var maxNullCurrentThreshold = 0.050; // in Ampere
function estimate_SOC(volt, current)
{
    let minCellVoltage=1.955; // V
    let maxCellVoltage=2.17; // V
    let SOC = undefined;
    if (current == undefined || Math.abs(current) < maxNullCurrentThreshold)
    {
        nullCounter++;
        if (current == undefined || nullCounter >= 5) // for 5 * 3 secs
        {
            volt = volt / 6.0;
	    var diff = maxCellVoltage - minCellVoltage;
	    SOC = Math.min(100.0, 100.0 * (volt - minCellVoltage) / diff);
	    SOC = Math.max(0.0, SOC);
        }
    }
    else 
    {
  	nullCounter = 0;
    }
    return SOC;
}

//var soc_log = fs.createWriteStream(__dirname + '/soc.log', {flags: 'a'});
var soc_log = fs.createWriteStream('/var/log/soc.log', {flags: 'a'});

var displayFunction = displayCurrentAndHistory;

var current_function_log = fs.createWriteStream('/var/log/current_plot.log', {flags: 'a'});
var currentListener = function(newCurrent, oldCurrent, precision, timestamp)
{
    var date = new Date();
    current_function_log.write(date.getTime() / 1000 + '\t' +  newCurrent + '\n');
}


var displayinterval = setInterval(function () {
    bmvdata = vedirect.update();
    displayFunction();
    let current       = bmvdata.batteryCurrent.formatted();
    let midVoltage    = bmvdata.midVoltage.formatted();
    let topVoltage    = bmvdata.topVoltage.formatted();
    log_buckets(bmvdata.batteryCurrent.value); // current in mA
    let topSOC        = estimate_SOC(topVoltage, current);
    let bottomSOC     = estimate_SOC(midVoltage, current);
    // topSOC or bottomSOC being undefined means that the current is too high
    if (topSOC !== undefined && bottomSOC !== undefined)
    {
	topSOC    = Math.round(topSOC);
	bottomSOC = Math.round(bottomSOC);
	if (topSOC != lastTopSOC || bottomSOC != lastBottomSOC)
	{
            var date = new Date();
	    //soc_log.write(date.toLocaleString('en-GB', { timeZone: 'UTC' }) + n'\t' + "top SOC: " + topSOC + '\t' + "bottom SOC: " + bottomSOC + '\n');
	    soc_log.write(date.toLocaleString() + '\t'
			  + "current: " + current + '\t'
			  + "top V: " +  topVoltage + '\t'
			  + "top SOC: " + topSOC
			  + " (" + (topSOC - lastTopSOC) + ")" + '\t'
			  + "bottom V: " + midVoltage + '\t'
			  + "bottom SOC: " + bottomSOC
			  + " (" + (bottomSOC - lastBottomSOC) + ")" + '\n');
	    //lastTopSOC = topSOC;
	    //lastBottomSOC = bottomSOC;
	    //lastStoredAh = getStoredAh();
	}
    }
    //process.stdout.write(topSOC);
    //process.stdout.write(bottomSOC);
  }, 3000);


var readDeviceConfig = function()
{
    logger.trace("readDeviceConfig");
    const file = __dirname + '/config.json';
    fs.readFile(file, 'utf8', (err, data) => {
	if (err) {
	    logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        } else {
	    logger.debug("Parse configuration (JSON format)");
	    let config = JSON.parse(data);
	    vedirect.setBatteryCapacity(config.BatteryCapacity);
	    vedirect.setChargedVoltage(config.ChargedVoltage);
	    vedirect.setTailCurrent(config.TailCurrent);
	    vedirect.setChargedDetectTime(config.ChargedDetectTime);
	    vedirect.setChargeEfficiency(config.ChargeEfficiency);
	    vedirect.setPeukertCoefficient(config.PeukertCoefficient);
	    vedirect.setCurrentThreshold(config.CurrentThreshold);
	    vedirect.setTimeToGoDelta(config.TimeToGoDelta);
	    vedirect.setRelayLowSOC(config.RelayLowSOC);
	    vedirect.setRelayLowSOCClear(config.RelayLowSOCClear);
        }
    });
}


var alarmOnOff = 0;

term.grabInput( { mouse: 'button' } ) ;

term.on( 'key' , function( name , matches , data ) {
    logger.debug( "'key' event:" + name + "; matches: " + matches);
    term.clear();

    if ( name === 'CTRL_C' ) {
	vedirect.stop();
	terminate() ;
    }
    //if ( matches.indexOf( 'CTRL_C' ) >= 0 ) terminate() ;
    name = name.toUpperCase()
    if ( name === 'R' )
    {
	term.clear();
	//term.moveto(20, 10);
	let relayOnOff = 0;
	if (bmvdata.relayState.value !== "OFF") relayOnOff = 1;
	if (relayOnOff == 1) {
	    term.green('Switch relay off');
	    vedirect.setRelay(0);
	}
	else {
	    term.green('Switch relay on');
	    vedirect.setRelay(1);
	}
    }
    else if ( name === 'S' )
    {
	term.green('Set SOC ' + minSOC + ' %');
 	vedirect.setStateOfCharge(minSOC);
    }
    else if ( name === 'P' )
    {
	term.green('Ping');
 	vedirect.ping();
    }
    else if ( name === 'V' )
    {
	term.green('App Version');
 	vedirect.app_version();
    }
    else if ( name === 'A' )
    {
	term.clear();
	//term.moveto(20, 10);
	// if (alarmOnOff == 0) {
	     term.green('Alarm acknowledged');
	     vedirect.clear_alarm();
	//     alarmOnOff = 1;
	// }
	// else {
	//     term.green('Switch alarm on');
	//     vedirect.set_alarm();
	//     alarmOnOff = 0;
	// }
    }
    else if ( name === 'B' )
    {
	term.red('Restarting');
	vedirect.restart();
    }
    else if ( name === 'D' )
    {
	term.yellow('Downloading configuration');
	vedirect.getDeviceConfig(true);
    }
    else if ( name === 'U' )
    {
	term.yellow('Uploading configuration');
	// TODO: test 
	readDeviceConfig();
    }
    else if ( name === 'T' )
    {
	if (displayFunction == displayConfiguration)
	    displayFunction = displayCurrentAndHistory;
	else
	    displayFunction = displayConfiguration;
    }
    else if ( name === 'L' )
    {
	if (vedirect.hasListener('batteryCurrent'))
	{
	    term.yellow('Stop Logging current');
	    vedirect.registerListener('batteryCurrent', null);
	}
	else
	{
	    term.yellow('Start Logging current');
	    vedirect.registerListener('batteryCurrent', currentListener);
	}
    }
} ) ;

readDeviceConfig();


// term.on( 'terminal' , function( name , data ) {
// 	logger.debug( "'terminal' event:" , name , data ) ;
// } ) ;

// term.on( 'mouse' , function( name , data ) {
// 	logger.debug( "'mouse' event:" , name , data ) ;
// } ) ;

// term.on( 'key' , function( name , matches , data ) {
// });

//var relayOnOffInterval = setInterval(function () {
//    vedirect.write(relayOnOff);
//    relayOnOff = ++relayOnOff % 2;
//  }, 70000);

// npm install onoff
// https://www.w3schools.com/nodejs/nodejs_raspberrypi_blinking_led.asp

