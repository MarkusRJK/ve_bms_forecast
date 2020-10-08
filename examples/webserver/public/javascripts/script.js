var alarmTimer = null;

onload=function()
{
    let imgPath = "images/128x128";

    const setSOC = function(socIn, batteryNo) {
	console.log("soc: " + socIn);
	let soc = parseFloat(socIn);
	if (isNaN(soc)) soc = 0;
	// drawing imgElement with height 0 yields in a filled red column
	if (soc < 0) soc = 0;
	if (soc > 100) soc = 100;
	let gImgElement = 'gBattery' + batteryNo;
	let oImgElement = 'oBattery' + batteryNo;
	let rImgElement = 'rBattery' + batteryNo;
	let imgElement = gImgElement;
	let htmlElement = 'soc' + batteryNo;
	if (soc < 10)
	    imgElement = rImgElement;
	else if (soc < 30)
	    imgElement = oImgElement;
	document.getElementById(gImgElement).setAttribute("style", "display:none");
	document.getElementById(oImgElement).setAttribute("style", "display:none");
	document.getElementById(rImgElement).setAttribute("style", "display:none");

	let height = (0.7 * soc).toFixed(0); // scale 
	let top = 88 - height;
	if (height != 0) 
	    document.getElementById(imgElement).setAttribute("style",
		"display:block;height:" + height + "%;top:" + top + "%");
	document.getElementById(htmlElement).innerHTML = soc.toFixed(0) + "%";
    }

    const switchDevices = function(appliances) {
	// hide everything:
	document.getElementById('bulb-on').setAttribute("style", "display:none");
	document.getElementById('bulb-off').setAttribute("style", "display:none");
	document.getElementById('fridge-on').setAttribute("style", "display:none");
	document.getElementById('fridge-off').setAttribute("style", "display:none");
	// document.getElementById('heating-on').setAttribute("style", "display:none");
	// document.getElementById('heating-off').setAttribute("style", "display:none");
	// //document.getElementById('microwave-on').setAttribute("style", "display:none");
	// //document.getElementById('microwave-off').setAttribute("style", "display:none");
	// document.getElementById('mixer-on').setAttribute("style", "display:none");
	// document.getElementById('mixer-off').setAttribute("style", "display:none");
	// document.getElementById('standMixer-on').setAttribute("style", "display:none");
	// document.getElementById('standMixer-off').setAttribute("style", "display:none");
	// document.getElementById('television-on').setAttribute("style", "display:none");
	// document.getElementById('television-off').setAttribute("style", "display:none");
	// document.getElementById('toaster-on').setAttribute("style", "display:none");
	// document.getElementById('toaster-off').setAttribute("style", "display:none");
	// document.getElementById('vacuum-cleaner-on').setAttribute("style", "display:none");
	// document.getElementById('vacuum-cleaner-off').setAttribute("style", "display:none");
	// document.getElementById('washing-machine-on').setAttribute("style", "display:none");
	// document.getElementById('washing-machine-off').setAttribute("style", "display:none");

	if (appliances.isBulbOn)
	    document.getElementById('bulb-on').setAttribute("style", "display:block");
	else document.getElementById('bulb-off').setAttribute("style", "display:block");
	if (appliances.isFridgeOn)
	    document.getElementById('fridge-on').setAttribute("style", "display:block");
	else
	    document.getElementById('fridge-off').setAttribute("style", "display:block");
	// if (appliances.isHeatingOn)
	//     document.getElementById('heating-on').setAttribute("style", "display:block");
	// else document.getElementById('heating-off').setAttribute("style", "display:block");
	// // if (appliances.isMicrowaveOn)
	// //     document.getElementById('microwave-on').setAttribute("style", "display:block");
	// // else document.getElementById('microwave-off').setAttribute("style", "display:block");
	// if (appliances.isMixerOn)
	//     document.getElementById('mixer-on').setAttribute("style", "display:block");
	// else document.getElementById('mixer-off').setAttribute("style", "display:block");
	// if (appliances.isStandMixerOn)
	//     document.getElementById('standMixer-on').setAttribute("style", "display:block");
	// else document.getElementById('standMixer-off').setAttribute("style", "display:block");
	// if (appliances.isTelevisionOn)
	//     document.getElementById('television-on').setAttribute("style", "display:block");
	// else document.getElementById('television-off').setAttribute("style", "display:block");
	// if (appliances.isToasterOn)
	//     document.getElementById('toaster-on').setAttribute("style", "display:block");
	// else document.getElementById('toaster-off').setAttribute("style", "display:block");
	// if (appliances.isVacuumCleanerOn)
	//     document.getElementById('vacuum-cleaner-on').setAttribute("style", "display:block");
	// else document.getElementById('vacuum-cleaner-off').setAttribute("style", "display:block");
	// if (appliances.isWashingMachineOn)
	//     document.getElementById('washing-machine-on').setAttribute("style", "display:block");
	// else document.getElementById('washing-machine-off').setAttribute("style", "display:block");
    }

    let updatePageObject = function(data) {
	// document.getElementById('Id').innerHTML = data.id;
//	if (data.soc !== undefined)
//	    document.getElementById('soc1').innerHTML = data.soc + " %";

        if (data.alarmState !== undefined)
	{
	    if (data.alarmState === 'ON') {
		alarmTimer = setTimeout(function() {
		    playSound('sounds/high_priority_alarm.wav');
		}, 10000);
              	document.getElementById('alarm-on').setAttribute("style", "display:block");
              	document.getElementById('alarm-off').setAttribute("style", "display:none");
            } else {
		clearTimeout(alarmTimer);
              	document.getElementById('alarm-off').setAttribute("style", "display:block");
              	document.getElementById('alarm-on').setAttribute("style", "display:none");
	    }
	} else console("alarmstate not defined");

	setSOC(data.lowerSOC, 1);
	setSOC(data.upperSOC, 2);
    }
    
    const sseSource = new EventSource('/event-stream');
    sseSource.addEventListener('message', (e) => {
        const jdata = e.data;
        const data = JSON.parse(jdata)

	console.log(data);
	updatePageObject(data);
	// for testing:

	switchDevices({});
    });

    // let initialData = {};
    // initialData.soc=50;
    // initialData.alarmState = "OFF";

    // updatePageObject(initialData);
    // initialData.alarmState = "ON";
    //setInterval(updatePageObject(initialData), 5000);

    switchDevices({});
};

// https://stackoverflow.com/questions/10105063/how-to-play-a-notification-sound-on-websites

function playSound(url) {
  const audio = new Audio(url);
  audio.play();
}



onunload=function()
{
    console.log("unload");
    sseSource.close();
}
