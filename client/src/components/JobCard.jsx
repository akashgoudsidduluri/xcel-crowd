import { useState, useEffect } from 'react';
import { getJobPipeline, createApplication } from '../api/index';
import '../styles/JobCard.css';

export default function JobCard({ job, currentUserEmail, onUpdate }) {
  const [pipeline, setPipeline] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '' });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (job?.id) {
      loadPipeline();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;

  const summary = pipeline?.summary ?? {
    active: 0,
    waitlisted: 0,
    hired: 0,
    rejected: 0,
  };

  // Determine if current user created this job
  const isJobCreator = job.created_by && currentUserEmail && job.created_by === currentUserEmail;

  const loadPipeline = async () => {
    try {
      setLoading(true);
      const response = await getJobPipeline(job.id);
      setPipeline(response.data);
    } catch (err) {
      console.error('Failed to load pipeline:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async (e) => {
    e.preventDefault();
    setError(null);
    if (!formData.name || !formData.email) {
      setError('Please fill in all fields');
      return;
    }

    try {
      setApplying(true);
      // Create application (which will create applicant if needed)
      await createApplication(formData.name, formData.email, job.id);
      
      setFormData({ name: '', email: '' });
      setShowForm(false);
      await loadPipeline();
      onUpdate();
    } catch (err) {
      if (err.response?.status === 409) {
        setError('Already applied to this job.');
      } else {
        setError(`Error: ${err.message}`);
      }
    } finally {
      setApplying(false);
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      ACTIVE: '#4CAF50',
      WAITLISTED: '#FFC107',
      HIRED: '#2196F3',
      REJECTED: '#F44336',
      DECAYED: '#FF9800',
    };
    return colors[status] || '#999';
  };

  return (
    <div className="job-card">
      <header className="card-header">
        <h3>{job.title}</h3>
        {isJobCreator && <span className="badge-creator">You created this</span>}
        <div className="capacity-bar">
          <div className="capacity-used" style={{
            width: `${(job.active_count / job.capacity) * 100}%`,
          }}></div>
        </div>
        <span className="capacity-label">
          {job.active_count} / {job.capacity} active
        </span>
      </header>

      {loading ? (
        <p className="loading">Loading pipeline...</p>
      ) : pipeline ? (
        <div className="pipeline-content">
          <div className="stats">
            <div className="stat">
              <span className="stat-value">{summary.active}</span>
              <span className="stat-label">Active</span>
            </div>
            <div className="stat">
              <span className="stat-value">{summary.waitlisted}</span>
              <span className="stat-label">Waitlisted</span>
            </div>
            <div className="stat">
              <span className="stat-value">{summary.hired}</span>
              <span className="stat-label">Hired</span>
            </div>
            <div className="stat">
              <span className="stat-value">{summary.rejected}</span>
              <span className="stat-label">Rejected</span>
            </div>
          </div>

          {pipeline.applicants?.length > 0 && (
            <div className="applicants-list">
              <h4>Recent Applicants</h4>
              {pipeline.applicants.slice(0, 5).map((app) => (
                <div key={app.id} className="applicant-item">
                  <div className="app-status" style={{
                    backgroundColor: getStatusColor(app.status),
                  }}></div>
                  <div className="app-info">
                    <div className="name">{app.name}</div>
                    <div className="status-text">
                      {app.status}
                      {app.status === 'WAITLISTED' && ` (#${app.queue_position})`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="card-actions">
        {!isJobCreator && (
          <button
            className="btn btn-small"
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? 'Cancel' : '+ Apply'}
          </button>
        )}
        {isJobCreator && (
          <span className="text-muted">You cannot apply to your own job</span>
        )}
      </div>

      {showForm && !isJobCreator && (
        <form className="apply-form" onSubmit={handleApply}>
          {error && <div className="error-banner" style={{ color: 'red', marginBottom: '10px' }}>{error}</div>}
          <input
            type="text"
            placeholder="Full Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            disabled={applying}
          />
          <input
            type="email"
            placeholder="Email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            disabled={applying}
          />
          <button type="submit" className="btn btn-primary" disabled={applying}>
            {applying ? 'Submitting...' : 'Submit Application'}
          </button>
        </form>
      )}
    </div>
  );
}
