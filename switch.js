// Todo: Switcher => MonitoredSwitch


// \brief  Switcher queues switch on/off commands
// \detail If the last switch activity was long enough in the past
//         then switch, otherwise set a timer for the next switch
//         activity so that it is executed only after a minimum
//         period of time (hysteresis by time)
class Switcher {
    // \param sw the bmv with a switch command setRelay(mode, priority, force)
    // \param minDurationInMin minimal duration between two switch commands in
    //        minutes
    constructor(sw, minDurationInMin) {
	this.sw = sw;
	this.minDurationInMin = minDurationInMin * 60000; // min -> ms
	this.lastTime = undefined;
	this.lastMode = undefined;
	this.switchDeferTimer = null;
    }

    setSwitch(mode, isForce) {
	let currentTime = new Date();

	if (this.switchDeferTimer)
	    // timer is already running => run last switch action
	    this.lastMode = mode;
	else if (this.lastTime === undefined || isForce
	    || currentTime - this.lastTime > this.minDurationInMS)
	{
	    this.lastTime = currentTime;
	    this.lastMode = mode;
	    doSwitchNow(isForce); // switch immediately
	}

	if (! this.switchDeferTimer) // timer not yet running => start defered execution
	    this.switchDeferTimer
		= setTimeout(function()
                             {
                                 this.doSwitchNow();
                             }.bind(this), this.minDurationInMS);
    }

    doSwitchNow(isForce) {
	if (isForce)
	    // switch with priority
	    this.sw.setRelay(this.lastMode, 1, isForce);
	else this.sw.setRelay(this.lastMode, 0);
	clearTimeout(this.switchDeferTimer);
	this.switchDeferTimer = null;
    }
}
