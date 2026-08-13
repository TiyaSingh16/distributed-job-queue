import { useState, useEffect } from 'react';
import './App.css';

const API_BASE = 'https://api-server-production-6280.up.railway.app';
function App() {
  const [imageUrl, setImageUrl] = useState('https://picsum.photos/800/600');
  const [width, setWidth] = useState(300);
  const [height, setHeight] = useState(300);
  const [jobs, setJobs] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const submitJob = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'resize-image',
          payload: { imageUrl, width: Number(width), height: Number(height) },
        }),
      });
      const data = await res.json();
      setJobs((prev) => [{ id: data.jobId, status: 'queued' }, ...prev]);
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
            return { id: job.id, status: data.status, result: data.result };
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

      <form onSubmit={submitJob} style={{ marginBottom: 30 }}>
        <div style={{ marginBottom: 10 }}>
          <label>Image URL: </label>
          <input
            type="text"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>Width: </label>
          <input type="number" value={width} onChange={(e) => setWidth(e.target.value)} />
          <label style={{ marginLeft: 10 }}>Height: </label>
          <input type="number" value={height} onChange={(e) => setHeight(e.target.value)} />
        </div>
        <button type="submit" disabled={submitting}>
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
            {job.result && (
              <div style={{ marginTop: 8 }}>
                <img src={job.result.imageUrl} alt="resized" style={{ maxWidth: 150, borderRadius: 4 }} />
                <div style={{ fontSize: 13, color: '#555' }}>
                  {job.result.sizeKB} KB —{' '}
                  <a href={job.result.imageUrl} target="_blank" rel="noreferrer">
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