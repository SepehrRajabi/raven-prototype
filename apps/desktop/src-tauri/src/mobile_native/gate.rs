//! MobileNative call eligibility. A call starts only in the foreground, but a foreground
//! service lets its audio keep running in the background, so `foreground` gates starting
//! a call and the camera, not audio. Leaving for good (swipe-away, Activity destroy)
//! ends the call. Closing this gate invalidates pending starts before
//! asynchronous device/network teardown can take its locks. Kept apart from `media.rs`
//! so its state machine is tested on the host.

#[derive(Debug)]
pub struct MobileNativeGate {
    pub foreground: bool,
    pub epoch: u64,
    pub call_active: bool,
    pub focused: bool,
    pub pending_stop: Option<u64>,
}

impl Default for MobileNativeGate {
    fn default() -> Self {
        Self {
            foreground: true,
            epoch: 0,
            call_active: false,
            focused: false,
            pending_stop: None,
        }
    }
}

impl MobileNativeGate {
    pub fn begin(&mut self, expected_epoch: u64) -> Result<(), &'static str> {
        if self.pending_stop.is_some() {
            return Err("The previous media is still stopping.");
        }
        if !self.foreground || self.epoch != expected_epoch {
            return Err("The call was cancelled while Raven was away.");
        }
        self.call_active = true;
        Ok(())
    }

    pub fn end(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.call_active = false;
        self.focused = false;
        self.pending_stop = Some(self.epoch);
    }

    pub fn finish_stop(&mut self, epoch: u64) {
        if self.pending_stop == Some(epoch) {
            self.pending_stop = None;
        }
    }

    /// The app left the screen during a call: only foreground-bound work (the camera)
    /// stops. The call, its epoch and its audio continue.
    pub fn background(&mut self) {
        self.foreground = false;
    }

    /// The app left for good: the call ends and pending starts are invalidated.
    pub fn terminate(&mut self) {
        self.background();
        self.end();
    }

    pub fn audio_allowed(&self) -> bool {
        self.call_active && self.focused
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_does_not_restore_call_or_validate_a_pending_start() {
        let mut gate = MobileNativeGate::default();
        let pending = gate.epoch;
        gate.begin(pending).unwrap();
        gate.focused = true;
        assert!(gate.audio_allowed());
        gate.terminate();
        gate.foreground = true;
        assert!(!gate.audio_allowed());
        assert!(gate.begin(pending).is_err());
        assert!(gate.begin(gate.epoch).is_err());
        gate.finish_stop(gate.epoch);
        gate.begin(gate.epoch).unwrap();
        assert!(!gate.audio_allowed());
        gate.focused = true;
        assert!(gate.audio_allowed());
    }

    #[test]
    fn backgrounding_keeps_the_call_and_audio_until_terminal() {
        let mut gate = MobileNativeGate::default();
        gate.begin(0).unwrap();
        gate.focused = true;
        gate.background();
        assert!(!gate.foreground && gate.call_active);
        assert!(gate.audio_allowed());
        assert_eq!((gate.epoch, gate.pending_stop), (0, None));
        gate.foreground = true;
        assert!(gate.call_active && gate.audio_allowed());
        assert_eq!(gate.epoch, 0);
        gate.background();
        gate.terminate();
        assert!(!gate.call_active && !gate.audio_allowed());
        assert_eq!(gate.pending_stop, Some(1));
        gate.foreground = true;
        assert!(gate.begin(0).is_err());
    }

    #[test]
    fn a_call_cannot_begin_while_backgrounded() {
        let mut gate = MobileNativeGate::default();
        gate.background();
        assert!(gate.begin(0).is_err());
    }

    #[test]
    fn focus_interruption_preserves_call_but_leave_cancels_its_recovery() {
        let mut gate = MobileNativeGate::default();
        gate.begin(0).unwrap();
        gate.focused = true;
        gate.focused = false;
        assert!(gate.call_active);
        assert!(!gate.audio_allowed());
        gate.end();
        gate.focused = true;
        assert!(!gate.audio_allowed());
        assert!(gate.begin(0).is_err());
    }

    #[test]
    fn older_teardown_cannot_release_a_newer_stop_barrier() {
        let mut gate = MobileNativeGate::default();
        gate.terminate();
        let old = gate.epoch;
        gate.end();
        gate.foreground = true;
        gate.finish_stop(old);
        assert!(gate.begin(gate.epoch).is_err());
        gate.finish_stop(gate.epoch);
        assert!(gate.begin(gate.epoch).is_ok());
    }
}
