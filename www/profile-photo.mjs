export async function prepareProfilePhoto(file, {
  decode = (image) => createImageBitmap(image, { imageOrientation: 'from-image' }),
  createCanvas = () => document.createElement('canvas'), maxDimension = 256, maxBytes = 256 * 1024
} = {}) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG or WebP picture no larger than 10 MB.');
  }
  const image = await decode(file);
  try {
    if (!image.width || !image.height) throw new Error('The picture has no usable image dimensions.');
    const scale = Math.min(1, maxDimension / image.width, maxDimension / image.height);
    const canvas = createCanvas();
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This device could not prepare the profile picture.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL('image/jpeg', 0.85);
    if (!photo.startsWith('data:image/jpeg;base64,') || photo.length > Math.ceil(maxBytes / 3) * 4 + 23) throw new Error('The picture could not be resized. Choose a smaller picture.');
    return photo;
  } finally { image.close(); }
}

export function wireProfilePhoto({ apiRequest, getOwner, alertError }) {
  const input = document.querySelector('#profile-photo-input');
  const remove = document.querySelector('#remove-profile-photo');
  const status = document.querySelector('#profile-photo-status');
  const images = [...document.querySelectorAll('[data-profile-photo]')];
  let generation = 0, busy = false;
  const show = (photo) => {
    for (const image of images) {
      if (photo) image.src = photo;
      else image.removeAttribute('src');
      image.hidden = !photo;
    }
    remove.hidden = !photo;
  };
  function reset() {
    generation++;
    busy = false;
    input.disabled = false;
    remove.disabled = false;
    input.value = '';
    show(null);
    status.textContent = '';
  }
  async function load() {
    if (busy) return;
    const owner = getOwner(), version = ++generation;
    status.textContent = 'Loading profile picture...';
    try {
      const data = await apiRequest('/api/auth/profile-photo');
      if (owner !== getOwner() || generation !== version) return;
      show(data.photo);
      status.textContent = data.offline_copy ? 'Downloaded profile picture. Reconnect to change it.' : data.photo ? 'Your profile picture.' : 'No profile picture added.';
    } catch (error) {
      if (owner !== getOwner() || generation !== version) return;
      status.textContent = error.message;
      console.error('Profile picture load failed:', error);
    }
  }
  async function save(file) {
    if (busy) return;
    const owner = getOwner(), version = ++generation;
    busy = true;
    input.disabled = true;
    remove.disabled = true;
    status.textContent = 'Saving profile picture...';
    try {
      if (navigator.onLine === false) throw new Error('Connect to the server before changing your profile picture.');
      const photo = file ? await prepareProfilePhoto(file) : null;
      if (owner !== getOwner() || generation !== version) return;
      const data = await apiRequest('/api/auth/profile-photo', { method: 'PUT', body: { photo } });
      if (owner !== getOwner() || generation !== version) return;
      show(data.photo);
      status.textContent = data.photo ? 'Profile picture saved.' : 'Profile picture removed.';
    } catch (error) {
      if (owner !== getOwner() || generation !== version) return;
      status.textContent = error.message;
      alertError(error, 'Could not update your profile picture.');
    } finally {
      if (owner === getOwner() && generation === version) {
        busy = false;
        input.disabled = false;
        remove.disabled = false;
        input.value = '';
      }
    }
  }
  input.addEventListener('change', () => { if (input.files[0]) void save(input.files[0]); });
  remove.addEventListener('click', () => { void save(null); });
  return { load, reset };
}
