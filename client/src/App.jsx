import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ApplicantView from './pages/ApplicantView';
import './App.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/applications/:applicationId" element={<ApplicantView />} />
      </Routes>
    </Router>
  );
}

export default App;
