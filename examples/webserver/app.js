var express = require('express'); // const?
var path = require('path');
var favicon = require('static-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser'); // const?
var session = require('express-session'); //const?
var bodyParser = require('body-parser'); 

var routes = require('./routes/index');
var users = require('./routes/users');

var app = express();

const vedirect = require( 've_bms_forecast' ).VitronEnergyDevice;
const Math = require('mathjs');

var bmvterminal = require("./bmv-terminal.js");

var messageId = 0;
var clientCtr = 0;


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(favicon());
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(cookieParser());

function sseDemo(req, res) {

    var portListener = function(newValue, oldValue, precision)
    {
	if (Math.abs(oldValue - newValue) <= precision) return;
	bmvdata = vedirect.update();
	let current   = bmvdata.batteryCurrent.formatted();
	// let topSOC    = getBestEstimateTopSOC(current).toFixed(1);
	// let bottomSOC = getBestEstimateBottomSOC(current).toFixed(1);

	// let minSOC;
	// if (topSOC && bottomSOC)
	//     minSOC = Math.min(topSOC, bottomSOC);
	// if ((isNaN(bmvdata.stateOfCharge.value)) || bmvdata.stateOfCharge.value * 0.1 > 100
	//     || bmvdata.stateOfCharge.value * 0.1 < 0)
	//     if (minSOC) vedirect.setStateOfCharge(minSOC);
	// if (minSOC && Math.abs(bmvdata.stateOfCharge.value * 0.1 - minSOC) >=1)
	// {
	//     vedirect.setStateOfCharge(minSOC);
	// }
	let data = {
	    'alarmState' : bmvdata.alarmState.value,
	    'relayState' : bmvdata.relayState.value,
	    'alarmReason': bmvdata.alarmReason.formatted(),
	    'midVoltage' : bmvdata.midVoltage.formattedWithUnit(),
	    'topVoltage' : bmvdata.topVoltage.formattedWithUnit(),
	    'current'    : bmvdata.batteryCurrent.formattedWithUnit(),
	    'soc'        : bmvdata.stateOfCharge.formattedWithUnit(),
	    'timeToGo'   : bmvdata.timeToGo.formattedWithUnit()
	};
	// for testing:
	// let data = {
	//     'id' : messageId,
	//     'SOC': '100%'
	// };
	let jdata = jsonConfig = JSON.stringify(data);
	res.write(`id: ${messageId}\n`);
	res.write(`data: ${jdata}\n\n`);
	console.log(jdata);
	//res.write(`data: Test Message -- ${Date.now()}\n\n`);
	messageId += 1;
    }

    //++clientCtr;
    //if (clientCtr > 1) return;
    
    console.log("Registering");
    vedirect.registerListener('batteryCurrent', portListener.bind(this));
    vedirect.registerListener('alarmState',     portListener.bind(this));
    vedirect.registerListener('relayState',     portListener.bind(this));
    vedirect.registerListener('alarmReason',    portListener.bind(this));
    vedirect.registerListener('midVoltage',     portListener.bind(this));
    vedirect.registerListener('topVoltage',     portListener.bind(this));
    vedirect.registerListener('stateOfCharge',  portListener.bind(this));
    vedirect.registerListener('timeToGo',       portListener.bind(this));
    
    // req.on('close', () => {
    //     //clearInterval(intervalId);
    // 	// deregister and close port?
    // 	if (--clientCtr === 0) {
    // 	    console.log("closing even source");
    // 	    vedirect.close();
    // 	}
    // });
}

app.use(cookieParser());
app.use(session({secret: "Shh, its a secret!"}));

// app.get('/', function(req, res){
//    if(req.session.page_views){
//       req.session.page_views++;
//       res.send("You visited this page " + req.session.page_views + " times");
//    } else {
//       req.session.page_views = 1;
//       res.send("Welcome to this page for the first time!");
//    }
// });

app.get('/event-stream', (req, res) => {
    // SSE Setup
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.write('\n');

    sseDemo(req.session, res);
});



app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);
app.use('/users', users);

/// catch 404 and forwarding to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

/// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

//app.listen(3001);
//console.log("Event-server running on port 3001");


module.exports = app;
