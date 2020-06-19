var sseSource;

onload=function()
{
    let imgPath = "images/128x128";
    
    const setSOC1 = function(soc) {
        if (soc === undefined) return;
	let imgElement = 'battery1';
	let htmlElement = 'soc1';
	if (soc < 12.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-0.png";
	else if (soc < 37.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-25.png";
	else if (soc < 62.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-50.png";
	else if (soc < 87.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-75.png";
	else 
	    document.getElementById(imgElement).src = imgPath + "/battery-100.png";
	document.getElementById(htmlElement).innerHTML = soc;
    }

    const setSOC1 = function(soc) {
        if (soc === undefined) return;
	let imgElement = 'battery2';
	let htmlElement = 'soc2';
	if (soc < 12.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-0.png";
	else if (soc < 37.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-25.png";
	else if (soc < 62.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-50.png";
	else if (soc < 87.5)
	    document.getElementById(imgElement).src = imgPath + "/battery-75.png";
	else 
	    document.getElementById(imgElement).src = imgPath + "/battery-100.png";
	document.getElementById(htmlElement).innerHTML = soc;
    }

    const switchDevices = function(appliances) {
	if (appliances.isBulbOn)
	    document.getElementById('bulb').src = imgPath + "/bulb.png";
	else document.getElementById('bulb').src = imgPath + "/bulb-bw.png";
	if (appliances.isFridgeOn)
	    document.getElementById('fridge').src = imgPath + "/fridge.png";
	else document.getElementById('fridge').src = imgPath + "/fridge-bw.png";
	if (appliances.isHeatingOn)
	    document.getElementById('heating').src = imgPath + "/heating.png";
	else document.getElementById('heating').src = imgPath + "/heating-bw.png";
	if (appliances.isMicrowaveOn)
	    document.getElementById('microwave').src = imgPath + "/microwave.png";
	else document.getElementById('microwave').src = imgPath + "/microwave-bw.png";
	if (appliances.isMixerOn)
	    document.getElementById('mixer').src = imgPath + "/mixer.png";
	else document.getElementById('mixer').src = imgPath + "/mixer-bw.png";
	if (appliances.isStandMixerOn)
	    document.getElementById('standMixer').src = imgPath + "/stand-mixer.png";
	else document.getElementById('standMixer').src = imgPath + "/stand-mixer-bw.png";
	if (appliances.isTelevisionOn)
	    document.getElementById('television').src = imgPath + "/television.png";
	else document.getElementById('television').src = imgPath + "/television-bw.png";
	if (appliances.isToasterOn)
	    document.getElementById('toaster').src = imgPath + "/toaster.png";
	else document.getElementById('toaster').src = imgPath + "/toaster-bw.png";
	if (appliances.isVacuumCleanerOn)
	    document.getElementById('vacuum-cleaner').src = imgPath + "/vacuum-cleaner.png";
	else document.getElementById('vacuum-cleaner').src = imgPath + "/vacuum-cleaner-bw.png";
	if (appliances.isWashingMachineOn)
	    document.getElementById('washing-machine').src = imgPath + "/washing-machine.png";
	else document.getElementById('washing-machine').src = imgPath + "/washing-machine-bw.png";
    }

    const sseSource = new EventSource('/event-stream');
       sseSource.addEventListener('message', (e) => {
           const jdata = e.data;
           const data = JSON.parse(jdata)

	   // for testing:
	   // document.getElementById('Id').innerHTML = data.id;
	   // document.getElementById('SOC').innerHTML = data.SOC;

           if (data.alarmState !== undefined)
              document.getElementById('alarm').innerHTML = data.alarmState;
           if (data.relayState !== undefined)
	      document.getElementById('relay').innerHTML = data.relayState;
           if (data.alarmReason !== undefined)
           //if (alarmReason in data)
	      document.getElementById('alarmReason').innerHTML = data.alarmReason;
           if (data.midVoltage !== undefined)
	      document.getElementById('midVoltage').innerHTML = data.midVoltage;
           if (data.topVoltage !== undefined)
	      document.getElementById('topVoltage').innerHTML = data.topVoltage;
           if (data.current !== undefined) {
	       document.getElementById('current').innerHTML = data.current;
	       if (data.current > 10)
		   document.getElementById('bulb').src = "images/light-bulb-bw.png";
	   }

	   setSOC1(50);
	   setSOC2(25);

	   // switchDevices((appliance)data);

           //if (data.soc !== undefined)
	   //   document.getElementById('soc').innerHTML = data.soc;
           if (data.timeToGo !== undefined)
	      document.getElementById('timeToGo').innerHTML = data.timeToGo;
       });
};

onunload=function()
{
    console.log("unload");
    sseSource.close();
}
