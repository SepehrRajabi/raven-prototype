//! Keeping a Bluetooth headset out of call mode.
//!
//! A Bluetooth headset plays stereo at full quality (A2DP) until something opens its
//! microphone. Then the system moves the whole headset, speakers included, to call mode
//! (HFP: mono, often 16 kHz) until the microphone is closed. Nothing else about a call
//! causes it, so the one way to prevent it is to use another microphone.
//!
//! With "Headset call mode" off, capture asks [`stand_in_for`] before opening a device. Only
//! macOS is covered: it says how each input is connected. Elsewhere no device is known to
//! be Bluetooth, so nothing is ever replaced and the interface does not offer the switch.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// How an input is connected, as far as choosing a stand-in cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputKind {
    Bluetooth,
    BuiltIn,
    /// A physical device on a cable.
    Wired,
    /// Virtual and aggregate devices, a phone's microphone, anything unrecognised. Never
    /// chosen as a stand-in: it may be silent, record something else or wake a phone.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Input {
    pub name: String,
    pub kind: InputKind,
}

/// The microphone to use so that no Bluetooth one is opened: the computer's own, else one
/// on a cable.
pub(crate) fn stand_in(inputs: &[Input]) -> Option<&str> {
    [InputKind::BuiltIn, InputKind::Wired]
        .into_iter()
        .find_map(|kind| inputs.iter().find(|input| input.kind == kind))
        .map(|input| input.name.as_str())
}

/// What to open instead of `wanted`. `None` keeps `wanted`: it is not Bluetooth, or there
/// is no other microphone, in which case being heard comes before how the headset sounds.
pub(crate) fn replacement<'a>(wanted: &str, inputs: &'a [Input]) -> Option<&'a str> {
    let bluetooth = inputs
        .iter()
        .any(|input| input.name == wanted && input.kind == InputKind::Bluetooth);
    if bluetooth {
        stand_in(inputs)
    } else {
        None
    }
}

/// [`replacement`] against the devices connected right now.
pub(crate) fn stand_in_for(wanted: &str) -> Option<String> {
    replacement(wanted, &inputs()).map(str::to_string)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn inputs() -> Vec<Input> {
    Vec::new()
}

#[cfg(target_os = "macos")]
pub(crate) use macos::inputs;

#[cfg(target_os = "macos")]
mod macos {
    use std::mem::size_of;
    use std::ptr::null;

    use coreaudio_sys::{
        kAudioDevicePropertyStreams, kAudioDevicePropertyTransportType,
        kAudioDeviceTransportTypeAVB, kAudioDeviceTransportTypeBluetooth,
        kAudioDeviceTransportTypeBluetoothLE, kAudioDeviceTransportTypeBuiltIn,
        kAudioDeviceTransportTypeDisplayPort, kAudioDeviceTransportTypeFireWire,
        kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypePCI,
        kAudioDeviceTransportTypeThunderbolt, kAudioDeviceTransportTypeUSB,
        kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMaster, kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput, kAudioObjectSystemObject,
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress,
    };
    use objc2::rc::Retained;
    use objc2_foundation::NSString;

    use super::{Input, InputKind};

    /// Every device with an input stream. Reads properties only, so it opens nothing and
    /// does not itself put a headset into call mode.
    pub(crate) fn inputs() -> Vec<Input> {
        device_ids()
            .into_iter()
            .filter(|id| has_input(*id))
            .filter_map(|id| {
                Some(Input {
                    name: name(id)?,
                    kind: kind(id),
                })
            })
            .collect()
    }

    fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMaster,
        }
    }

    fn property_size(object: AudioObjectID, address: &AudioObjectPropertyAddress) -> Option<u32> {
        let mut size = 0_u32;
        // SAFETY: `address` and `size` outlive the call; no qualifier is passed.
        let status =
            unsafe { AudioObjectGetPropertyDataSize(object, address, 0, null(), &mut size) };
        (status == 0).then_some(size)
    }

    fn device_ids() -> Vec<AudioObjectID> {
        let address = address(
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
        );
        let Some(mut size) = property_size(kAudioObjectSystemObject, &address) else {
            return Vec::new();
        };
        let mut ids = vec![0 as AudioObjectID; size as usize / size_of::<AudioObjectID>()];
        // SAFETY: the buffer holds `size` bytes, and CoreAudio writes at most that many.
        let status = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &address,
                0,
                null(),
                &mut size,
                ids.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        // A device that left between the two calls makes the list shorter.
        ids.truncate(size as usize / size_of::<AudioObjectID>());
        ids
    }

    fn has_input(id: AudioObjectID) -> bool {
        property_size(
            id,
            &address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput),
        )
        .is_some_and(|size| size > 0)
    }

    fn name(id: AudioObjectID) -> Option<String> {
        let address = address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
        let mut string: *mut NSString = std::ptr::null_mut();
        let mut size = size_of::<*mut NSString>() as u32;
        // SAFETY: the property is one CFStringRef, which is toll-free bridged to NSString.
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &address,
                0,
                null(),
                &mut size,
                (&mut string as *mut *mut NSString).cast(),
            )
        };
        if status != 0 {
            return None;
        }
        // SAFETY: the caller owns the returned string; null gives `None`.
        unsafe { Retained::from_raw(string) }.map(|name| name.to_string())
    }

    fn kind(id: AudioObjectID) -> InputKind {
        let address = address(
            kAudioDevicePropertyTransportType,
            kAudioObjectPropertyScopeGlobal,
        );
        let mut transport = 0_u32;
        let mut size = size_of::<u32>() as u32;
        // SAFETY: the property is one u32 and the buffer is one u32.
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &address,
                0,
                null(),
                &mut size,
                (&mut transport as *mut u32).cast(),
            )
        };
        if status != 0 {
            return InputKind::Other;
        }
        #[allow(non_upper_case_globals)]
        match transport {
            kAudioDeviceTransportTypeBluetooth | kAudioDeviceTransportTypeBluetoothLE => {
                InputKind::Bluetooth
            }
            kAudioDeviceTransportTypeBuiltIn => InputKind::BuiltIn,
            kAudioDeviceTransportTypeUSB
            | kAudioDeviceTransportTypePCI
            | kAudioDeviceTransportTypeFireWire
            | kAudioDeviceTransportTypeThunderbolt
            | kAudioDeviceTransportTypeHDMI
            | kAudioDeviceTransportTypeDisplayPort
            | kAudioDeviceTransportTypeAVB => InputKind::Wired,
            _ => InputKind::Other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, kind: InputKind) -> Input {
        Input {
            name: name.to_string(),
            kind,
        }
    }

    #[test]
    fn a_headset_is_replaced_by_the_computers_own_microphone_first() {
        let inputs = [
            input("Headset", InputKind::Bluetooth),
            input("USB microphone", InputKind::Wired),
            input("Built-in", InputKind::BuiltIn),
        ];
        assert_eq!(replacement("Headset", &inputs), Some("Built-in"));
        assert_eq!(replacement("Headset", &inputs[..2]), Some("USB microphone"));
    }

    #[test]
    fn a_microphone_that_is_not_bluetooth_is_kept() {
        let inputs = [
            input("Headset", InputKind::Bluetooth),
            input("USB microphone", InputKind::Wired),
            input("Built-in", InputKind::BuiltIn),
            input("Loopback", InputKind::Other),
        ];
        for wanted in ["USB microphone", "Built-in", "Loopback", "Not connected"] {
            assert_eq!(replacement(wanted, &inputs), None, "{wanted}");
        }
    }

    #[test]
    fn a_virtual_device_never_stands_in_and_the_headset_is_kept_when_it_is_the_only_one() {
        let inputs = [
            input("Virtual", InputKind::Other),
            input("Headset", InputKind::Bluetooth),
            input("Other headset", InputKind::Bluetooth),
        ];
        assert_eq!(stand_in(&inputs), None);
        assert_eq!(replacement("Headset", &inputs), None);
    }

    /// Every device capture can open must be known here by the same name.
    #[cfg(target_os = "macos")]
    #[test]
    fn input_names_match_the_ones_capture_lists() {
        use cpal::traits::{DeviceTrait, HostTrait};
        let listed: Vec<String> = cpal::default_host()
            .input_devices()
            .map(|devices| devices.filter_map(|device| device.name().ok()).collect())
            .unwrap_or_default();
        let named: Vec<String> = inputs().into_iter().map(|input| input.name).collect();
        for name in listed {
            assert!(named.contains(&name), "{name} is missing from {named:?}");
        }
    }
}
