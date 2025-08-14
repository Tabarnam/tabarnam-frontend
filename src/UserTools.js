// C:\Users\jatlas\OneDrive\Tabarnam Inc\MVP Do It Yourself\tabarnam-frontend\src\UserTools.js
import React, { useState, useEffect } from 'react';
import axios from 'axios';

const UserTools = () => {
  const [companies, setCompanies] = useState([]);
  const [query, setQuery] = useState('candles'); // Default query
  const functionKey = import.meta.env.VITE_FUNCTION_KEY; // Set in Azure env vars

  useEffect(() => {
    if (!functionKey) {
      console.error('Missing VITE_FUNCTION_KEY');
      return;
    }
    // Fetch from backend
    axios
      .post(
        `https://tabarnam-xai-dedicated-b4a0gdchamaeb8cp.canadacentral-01.azurewebsites.net/xai?code=${functionKey}`,
        { query }
      )
      .then((response) => setCompanies(response.data.companies))
      .catch((error) => console.error('Error fetching companies:', error));
  }, [query, functionKey]);

  const exportToCSV = () => {
    const csv = companies.map((c) => `${c.company_name},${c.company_tagline},${c.industries.join(';')}`).join('\n');
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
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Enter search query (e.g., candles)"
      />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Tagline</th>
            <th>Industries</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
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