// src/UserTools.js
import React, { useState, useEffect } from 'react';
import axios from 'axios';

const UserTools = () => {
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    // Fetch from backend (adjust URL to your Function App)
    axios.get('https://tabarnam-xai-dedicated-b4a0gdchamaeb8cp.canadacentral-01.azurewebsites.net/companies')
      .then(response => setCompanies(response.data))
      .catch(error => console.error('Error:', error));
  }, []);

  const exportToCSV = () => {
    const csv = companies.map(c => `${c.company_name},${c.company_tagline},${c.industries.join(';')}`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'companies.csv';
    a.click();
  };

  return (
    <div>
      <h2>User Tools</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Tagline</th>
            <th>Industries</th>
          </tr>
        </thead>
        <tbody>
          {companies.map(c => (
            <tr key={c.company_name}>
              <td>{c.company_name}</td>
              <td>{c.company_tagline}</td>
              <td>{c.industries.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={exportToCSV}>Export to CSV</button>
    </div>
  );
};

export default UserTools;