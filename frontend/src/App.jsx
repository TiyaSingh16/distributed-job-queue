import { useState, useEffect } from 'react';
import './App.css';
import { requestJson, validateSubmission, TERMINAL_STATUSES, MIN_DIMENSION, MAX_DIMENSION } from './api.js';

const errorBoxStyle = {
  background: '#fdecea',
  border: '1px solid #f5c2c0',
  color: '#8a1f17',
  borderRadius: 6,
  padding: '8px 12px',
  marginBottom: 12,
  fontSize: 14,
};

function ErrorMessage({ message, onRetry }) {
  if (!message) return null;
  return (
    <div role="alert" style={errorBoxStyle}>
      {message}
      {onRetry && (
        <button type="button" onClick={onRetry} style={{ marginLeft: 10 }}>
          Try again
        </button>
      )}
    </div>
  );
}

function SubmitTab({ jobs, setJobs }) {
  const [mode, setMode] = useState('url'); // 'url' | 'file'
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [width, setWidth] = useState(300);
  const [height, setHeight] = useState(300);
  const [submitting, setSubmitting] = useState(false);

  const [submitError, setSubmitError] = useState('');
  const [pollWarning, setPollWarning] = useState('');

  const submitJob = async (e) => {
    e.preventDefault();
    const problem = validateSubmission({ mode, imageUrl, imageFile, width, height });
    if (problem) {
      setSubmitError(problem);
      return;
    }
    setSubmitError('');
    setSubmitting(true);
    try {
      let data;
      if (mode === 'file') {
        const formData = new FormData();
        formData.append('image', imageFile);
        formData.append('width', width);
        formData.append('height', height);
        data = await requestJson(
          '/jobs/upload',
          { method: 'POST', body: formData },
          { fallback: 'Could not submit the job. Please try again.' }
        );
      } else {
        data = await requestJson(
          '/jobs',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'resize-image',
              payload: { imageUrl: imageUrl.trim(), width: Number(width), height: Number(height) },
            }),
          },
          { fallback: 'Could not submit the job. Please try again.' }
        );
      }
      if (!data.jobId) throw new Error('Response had no jobId');
      setJobs((prev) => [{ id: data.jobId, status: 'queued' }, ...prev]);
      setImageFile(null);
    } catch (err) {
      setSubmitError(err.userMessage || 'Could not submit the job. Please try again.');
      if (!err.userMessage) console.error('Failed to submit job:', err);
    } finally {
      setSubmitting(false);
    }
  };

  // Poll every 2 seconds, but only jobs that can still change. If polling
  // fails (server asleep, network down) the jobs keep their last known status
  // and a notice explains why nothing is updating; it clears on the next
  // successful poll.
  useEffect(() => {
    const pending = jobs.filter((job) => !TERMINAL_STATUSES.includes(job.status));
    if (pending.length === 0) return undefined;
    const interval = setInterval(async () => {
      let failures = 0;
      const updates = await Promise.all(
        pending.map(async (job) => {
          try {
            const data = await requestJson(`/jobs/${encodeURIComponent(job.id)}`);
            return { id: job.id, status: data.status, result: data.result, error: data.error };
          } catch {
            failures += 1;
            return null;
          }
        })
      );
      setPollWarning(
        failures > 0 ? 'Having trouble reaching the server to refresh job status. Retrying automatically...' : ''
      );
      const byId = new Map(updates.filter(Boolean).map((u) => [u.id, u]));
      if (byId.size > 0) setJobs((prev) => prev.map((job) => byId.get(job.id) || job));
    }, 2000);
    return () => clearInterval(interval);
  }, [jobs, setJobs]);

  return (
    <>
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

      <form onSubmit={submitJob} style={{ marginBottom: 30 }} noValidate>
        <ErrorMessage message={submitError} />
        {mode === 'url' ? (
          <>
            <div style={{ marginBottom: 4 }}>
              <label>Image URL: </label>
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => {
                  setImageUrl(e.target.value);
                  setSubmitError('');
                }}
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
              onChange={(e) => {
                setImageFile(e.target.files[0] || null);
                setSubmitError('');
              }}
            />
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <label>Width (px): </label>
          <input
            type="number"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            min={MIN_DIMENSION}
            max={MAX_DIMENSION}
          />
          <label style={{ marginLeft: 10 }}>Height (px): </label>
          <input
            type="number"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            min={MIN_DIMENSION}
            max={MAX_DIMENSION}
          />
        </div>

        <button type="submit" disabled={submitting || (mode === 'url' ? !imageUrl.trim() : !imageFile)}>
          {submitting ? 'Submitting...' : 'Submit Job'}
        </button>
      </form>

      <h2>This Session's Jobs</h2>
      {pollWarning && <p style={{ fontSize: 13, color: '#8a6d00' }}>{pollWarning}</p>}
      {jobs.length === 0 && <p>No jobs submitted yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {jobs.map((job) => (
          <li key={job.id} style={{ border: '1px solid #ccc', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <strong>Job {job.id}</strong> — {job.status}
            {job.status === 'failed' && job.error && (
              <div style={{ fontSize: 13, color: '#c0392b', marginTop: 4 }}>{job.error}</div>
            )}
            {job.result && (
              <div style={{ marginTop: 8 }}>
                <img src={job.result.imageUrl} alt="resized" style={{ maxWidth: 150, borderRadius: 4 }} />
                <div style={{ fontSize: 13, color: '#555' }}>
                  {job.result.sizeKB} KB —{' '}
                  <a href={job.result.imageUrl.replace('/upload/', '/upload/fl_attachment/')}>Download</a>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function HistoryTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  // The result of the last finished request, tagged with which request it was
  // for. "Loading" is derived (latest result is for an older request) rather
  // than set inside the effect, which avoids cascading renders.
  const [view, setView] = useState({ key: null, jobs: [], pagination: null, error: '' });
  const requestKey = `${page}|${status}|${reloadCount}`;
  const loading = view.key !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page, limit: 10 });
    if (status) params.append('status', status);
    requestJson(`/jobs?${params}`, {}, { fallback: 'Could not load job history. Please try again.' }).then(
      (data) => {
        if (cancelled) return;
        setView({ key: requestKey, jobs: data.jobs || [], pagination: data.pagination || null, error: '' });
      },
      (err) => {
        if (cancelled) return;
        // Keep the previously shown page so the list doesn't vanish on a blip.
        setView((prev) => ({ ...prev, key: requestKey, error: err.userMessage || 'Could not load job history.' }));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [page, status, requestKey]);

  const { jobs, pagination, error } = view;

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <label>Filter by status: </label>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All</option>
          <option value="queued">Queued</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading && <p>Loading...</p>}
      {!loading && <ErrorMessage message={error} onRetry={() => setReloadCount((n) => n + 1)} />}
      {!loading && !error && jobs.length === 0 && <p>No jobs found.</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {jobs.map((job) => (
          <li key={job._id} style={{ border: '1px solid #ccc', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <div>
              <strong>Job {job.bullJobId}</strong> — {job.status}{' '}
              <span style={{ fontSize: 12, color: '#888' }}>
                {new Date(job.createdAt).toLocaleString()}
              </span>
            </div>
            {job.status === 'failed' && job.error && (
              <div style={{ fontSize: 13, color: '#c0392b', marginTop: 4 }}>{job.error}</div>
            )}
            {job.result?.imageUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={job.result.imageUrl} alt="resized" style={{ maxWidth: 100, borderRadius: 4 }} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {pagination && pagination.totalPages > 1 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </span>
          <button disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}

function App() {
  const [tab, setTab] = useState('submit'); // 'submit' | 'history'
  const [jobs, setJobs] = useState([]);

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Distributed Job Queue</h1>

      <div style={{ marginBottom: 24, borderBottom: '1px solid #ddd', paddingBottom: 10 }}>
        <button
          type="button"
          onClick={() => setTab('submit')}
          style={{ fontWeight: tab === 'submit' ? 'bold' : 'normal', marginRight: 16 }}
        >
          Submit a Job
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          style={{ fontWeight: tab === 'history' ? 'bold' : 'normal' }}
        >
          Job History
        </button>
      </div>

      {tab === 'submit' ? <SubmitTab jobs={jobs} setJobs={setJobs} /> : <HistoryTab />}
    </div>
  );
}

export default App;