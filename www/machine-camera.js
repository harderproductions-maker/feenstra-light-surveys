import { Capacitor, registerPlugin } from '@capacitor/core';

const CameraCapture = registerPlugin('CameraCapture');

async function browserPhoto(host) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs the phone app or a secure HTTPS browser.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  if (!host.isConnected) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('The report was closed. Open it again to take a photo.');
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'machine-camera';
  dialog.innerHTML = '<p>Point the camera at this machine.</p><video autoplay playsinline muted></video><p><button type="button" class="button primary" data-camera-snap>Take photo</button> <button type="button" class="button secondary" data-camera-cancel>Cancel</button></p><p role="status"></p>';
  host.append(dialog);
  const video = dialog.querySelector('video');
  video.srcObject = stream;
  let observer;
  try {
    dialog.showModal();
    await video.play();
    return await new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('Photo cancelled. Take a new photo before adding the machine.'));
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel(); });
      dialog.querySelector('[data-camera-cancel]').onclick = cancel;
      observer = new MutationObserver(() => { if (!dialog.isConnected) cancel(); });
      observer.observe(document.body, { childList: true, subtree: true });
      dialog.querySelector('[data-camera-snap]').onclick = () => {
        if (!video.videoWidth || !video.videoHeight) {
          dialog.querySelector('[role="status"]').textContent = 'Camera is not ready yet. Try again.';
          return;
        }
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve({ data: canvas.toDataURL('image/jpeg', 0.65), capturedAt: new Date().toISOString() });
      };
    });
  } finally {
    observer?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    dialog.remove();
  }
}

export async function takeMachinePhoto(host) {
  let photo;
  if (Capacitor.isNativePlatform()) {
    const result = await CameraCapture.capture({ maintenanceTicket: true, buildingName: 'Laundry check', entryName: 'Machine evidence' });
    if (result.cancelled) throw new Error('Photo cancelled. Take a photo before adding the machine.');
    if (!result.base64 || !Number.isFinite(result.capturedAt)) throw new Error('The camera did not return a photo and capture time.');
    photo = { data: `data:image/jpeg;base64,${result.base64}`, capturedAt: new Date(result.capturedAt).toISOString() };
  } else {
    photo = await browserPhoto(host);
  }
  const image = new Image();
  image.src = photo.data;
  await image.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  let data = canvas.toDataURL('image/jpeg', 0.65);
  if (data.length > 180000) data = canvas.toDataURL('image/jpeg', 0.4);
  if (data.length > 180000) throw new Error('The camera photo is too large. Retake it with a simpler background.');
  return { data, capturedAt: photo.capturedAt, source: 'camera' };
}
