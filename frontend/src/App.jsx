import { useState, useEffect } from 'react';
import './App.css';

const API_BASE = 'https://api-server-tyjz.onrender.com';

function App() {
  const [mode, setMode] = useState('url'); // 'url' | 'file'
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [width, setWidth] = useState(300);
  const [height, setHeight] = useState(300);
  const [jobs, setJobs] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const submitJob = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      let res;
      if (mode === 'file') {
        if (!imageFile) return;
        const formData = new FormData();
        formData.append('image', imageFile);
        formData.append('width', width);
        formData.append('height', height);
        res = await fetch(`${API_BASE}/jobs/upload`, {
          method: 'POST',
          body: formData, // no Content-Type header — browser sets it with the correct boundary
        });
      } else {
        if (!imageUrl.trim()) return;
        res = await fetch(`${API_BASE}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'resize-image',
            payload: { imageUrl, width: Number(width), height: Number(height) },
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Submission failed');
      setJobs((prev) => [{ id: data.jobId, status: 'queued' }, ...prev]);
      setImageFile(null);
    } catch (err) {
      console.error('Failed to submit job:', err);
    } finally {
      setSubmitting(false);
    }
  };

  // Poll status for all jobs every 2 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      const updated = await Promise.all(
        jobs.map(async (job) => {
          try {
            const res = await fetch(`${API_BASE}/jobs/${job.id}`);
            if (!res.ok) return job;
            const data = await res.json();
            return {
              id: job.id,
              status: data.status,
              result: data.result,
              error: data.error,
            };
          } catch {
            return job;
          }
        })
      );
      setJobs(updated);
    }, 2000);
    return () => clearInterval(interval);
  }, [jobs]);

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Distributed Job Queue</h1>

      {/* Mode toggle */}
      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setMode('url')}
          style={{ fontWeight: mode === 'url' ? 'bold' : 'normal', marginRight: 10 }}
        >
          Use Image URL
        </button>
        <button
          type="button"
          onClick={() => setMode('file')}
          style={{ fontWeight: mode === 'file' ? 'bold' : 'normal' }}
        >
          Upload a Photo
        </button>
      </div>

      <form onSubmit={submitJob} style={{ marginBottom: 30 }}>
        {mode === 'url' ? (
          <>
            <div style={{ marginBottom: 4 }}>
              <label>Image URL: </label>
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://example.com/photo.jpg"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
              Must be a direct link to an image file (ends in .jpg, .png, .webp).
              Links to a webpage — Google Images results, Instagram or Pinterest
              posts — won't work.
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <label>Choose a photo from your device: </label>
            <br />
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setImageFile(e.target.files[0] || null)}
            />
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <label>Width (px): </label>
          <input type="number" value={width} onChange={(e) => setWidth(e.target.value)} min="10" max="2000" />
          <label style={{ marginLeft: 10 }}>Height (px): </label>
          <input type="number" value={height} onChange={(e) => setHeight(e.target.value)} min="10" max="2000" />
        </div>

        <button
          type="submit"
          disabled={submitting || (mode === 'url' ? !imageUrl.trim() : !imageFile)}
        >
          {submitting ? 'Submitting...' : 'Submit Job'}
        </button>
      </form>

      <h2>Jobs</h2>
      {jobs.length === 0 && <p>No jobs submitted yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {jobs.map((job) => (
          <li
            key={job.id}
            style={{
              border: '1px solid #ccc',
              borderRadius: 6,
              padding: 10,
              marginBottom: 8,
            }}
          >
            <strong>Job {job.id}</strong> — {job.status}

            {job.status === 'failed' && job.error && (
              <div style={{ fontSize: 13, color: '#c0392b', marginTop: 4 }}>
                {job.error}
              </div>
            )}

            {job.result && (
              <div style={{ marginTop: 8 }}>
                <img
                  src={job.result.imageUrl}
                  alt="resized"
                  style={{ maxWidth: 150, borderRadius: 4 }}
                />
                <div style={{ fontSize: 13, color: '#555' }}>
                  {job.result.sizeKB} KB —{' '}
                  <a href={job.result.imageUrl.replace('/upload/', '/upload/fl_attachment/')}>
                    Download
                  </a>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;