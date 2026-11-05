const maxBytes = 256 * 1024;
const schema = `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS profile_photo BYTEA
  CHECK (profile_photo IS NULL OR octet_length(profile_photo) <= ${maxBytes})`;

function mount(app, { pool, authenticate, apiError, isValidJpeg }) {
  const photoValue = (photo) => photo ? `data:image/jpeg;base64,${photo.toString('base64')}` : null;
  app.get('/api/auth/profile-photo', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT profile_photo FROM app_users WHERE id=$1', [req.user.id]);
      return res.json({ photo: photoValue(rows[0].profile_photo) });
    } catch (error) {
      console.error('Profile picture lookup failed:', error.message);
      return apiError(res, 503, 'Could not load your profile picture.');
    }
  });
  app.put('/api/auth/profile-photo', authenticate, async (req, res) => {
    const value = req.body?.photo;
    let photo = null;
    if (value !== null) {
      if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 23
          || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return apiError(res, 400, 'Choose a JPEG profile picture no larger than 256 KB.');
      }
      photo = Buffer.from(value.slice(23), 'base64');
      if (photo.length > maxBytes || !isValidJpeg(photo)) return apiError(res, 400, 'The profile picture must be a complete JPEG no larger than 256 KB.');
    }
    try {
      await pool.query('UPDATE app_users SET profile_photo=$2 WHERE id=$1', [req.user.id, photo]);
      return res.json({ photo: photoValue(photo) });
    } catch (error) {
      console.error('Profile picture save failed:', error.message);
      return apiError(res, 503, 'Could not save your profile picture. Reconnect and retry.');
    }
  });
}

module.exports = { schema, mount };
