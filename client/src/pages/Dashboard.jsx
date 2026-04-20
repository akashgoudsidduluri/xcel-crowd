import { useState, useEffect } from 'react';
import { getJobs, createJob } from '../api/index';
import JobCard from '../components/JobCard';
import '../styles/Dashboard.css';

export default function Dashboard() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ title: '', capacity: '', created_by: '' });
  const [currentUserEmail, setCurrentUserEmail] = useState('');

  useEffect(() => {
    // Try to get current user email from localStorage
    const storedEmail = localStorage.getItem('currentUserEmail');
    if (storedEmail) {
      setCurrentUserEmail(storedEmail);
    }
    
    loadJobs();
    const interval = setInterval(loadJobs, 15000); // Poll every 15s
    return () => clearInterval(interval);
  }, []);

  const loadJobs = async () => {
    try {
      setLoading(true);
      const response = await getJobs();
      setJobs(response.data);
      setError(null);
    } catch (err) {
      setError(`Failed to load jobs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateJob = async (e) => {
    e.preventDefault();
    if (!formData.title || !formData.capacity) {
      alert('Please fill in all fields');
      return;
    }

    const email = formData.created_by || currentUserEmail;
    if (email) {
      localStorage.setItem('currentUserEmail', email);
      setCurrentUserEmail(email);
    }

    try {
      await createJob(formData.title, parseInt(formData.capacity), email || null);
      setFormData({ title: '', capacity: '', created_by: '' });
      setShowForm(false);
      await loadJobs();
    } catch (err) {
      alert(`Error creating job: ${err.message}`);
    }
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Next In Line — ATS Pipeline</h1>
        {currentUserEmail && <span className="current-user">Logged in as: {currentUserEmail}</span>}
        <button 
          className="btn btn-primary" 
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Job'}
        </button>
      </header>

      {showForm && (
        <form className="job-form" onSubmit={handleCreateJob}>
          <input
            type="email"
            placeholder="Your Email (optional)"
            value={formData.created_by}
            onChange={(e) => setFormData({ ...formData, created_by: e.target.value })}
          />
          <input
            type="text"
            placeholder="Job Title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          />
          <input
            type="number"
            placeholder="Capacity"
            min="1"
            value={formData.capacity}
            onChange={(e) => setFormData({ ...formData, capacity: e.target.value })}
          />
          <button type="submit" className="btn btn-primary">
            Create Job
          </button>
        </form>
      )}

      {error && <div className="error-banner">{error}</div>}

      {loading && <p className="loading">Loading jobs...</p>}

      <div className="jobs-grid">
        {jobs?.map((job) => (
          <JobCard key={job.id} job={job} currentUserEmail={currentUserEmail} onUpdate={loadJobs} />
        ))}
      </div>

      {!loading && jobs.length === 0 && (
        <div className="empty-state">
          <p>No jobs yet. Create one to get started!</p>
        </div>
      )}
    </div>
  );
}
