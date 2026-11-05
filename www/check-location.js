import { Capacitor, registerPlugin } from '@capacitor/core';

const CheckLocation = registerPlugin('CheckLocation');

export async function captureCheckLocation() {
  let reading;
  if (Capacitor.isNativePlatform()) {
    reading = await CheckLocation.capture();
  } else {
    if (!globalThis.isSecureContext || !navigator.geolocation) {
      throw new Error('Location requires the installed phone app or a secure HTTPS browser connection.');
    }
    reading = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy, timestamp: position.timestamp, mocked: false
      }),
      (error) => reject(new Error(`Location is required to complete the check. ${error.message}`)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    ));
  }
  if (!Number.isFinite(reading.timestamp) || Math.abs(Date.now() - reading.timestamp) > 15000) {
    throw new Error('The location reading is out of date. Try again outside or near a window.');
  }
  if (reading.mocked) throw new Error('Mock location detected. Turn off mock locations and try again.');
  return {
    latitude: reading.latitude, longitude: reading.longitude, accuracy: reading.accuracy,
    capturedAt: new Date(reading.timestamp).toISOString(), mocked: reading.mocked
  };
}
