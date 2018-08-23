'use strict';

const Math = require('mathjs');
var util = require('util');

var log_stdout = process.stdout;


var avgBaseCurrentLowVoltage = 460; // mA
var inverterBaseCurrent = 5590 - avgBaseCurrentLowVoltage; // mA

var latitude=53.4853; // degrees
var inclination=23.44; // degrees
var roofInclination=34.8657; // degrees

function getDayAfterLowestSun() {
    var date = new Date();
    var y = date.getFullYear();
    var m = date.getMonth();
    var d = date.getDate();
    var h = date.getHours();
    var dateOfLowestSun;
    // December is 11!!!
    if (m == 11 && d >= 21)
    {
        dateOfLowestSun = new Date(y, 11, 21, h);
    }
    else
    {
        dateOfLowestSun = new Date(y-1, 11, 21, h);
    }
    var millisecSinceLowestSun = date.getTime() - dateOfLowestSun.getTime(); // in millisecs
    return Math.floor(millisecSinceLowestSun / (1000 * 60 * 60 * 24)); // in days
}

var earthInclination = function() // in degrees
{
    var d = getDayAfterLowestSun();
    return inclination * Math.cos(2.0 * d * Math.PI / 365.0 - Math.PI);
}

var degreeToRad = function(d)
{
    return Math.PI * d / 180;
}

var angularImpactReductionFactor = function(dayOfYear)
{
    var l = degreeToRad(latitude);
    var r = degreeToRad(roofInclination);
    var e = degreeToRad(earthInclination());
    return Math.cos(l - r - e);
}

log_stdout.write("days since last low sun " + getDayAfterLowestSun() + '\n');
log_stdout.write("earth inclination " + earthInclination() + '\n');
log_stdout.write("factor " + angularImpactReductionFactor() + '\n');

