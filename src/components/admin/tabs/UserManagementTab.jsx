import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAdminUser, getAuthorizedAdminEmails } from '@/lib/azureAuth';

const UserManagementTab = () => {
  const currentUser = getAdminUser();
  const authorizedEmails = getAuthorizedAdminEmails();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Authorized Admin Users</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 mb-4">
            All authorized admins have full access to the system. Access is managed via Azure Entra ID.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left p-3 font-semibold text-slate-700">Email</th>
                  <th className="text-left p-3 font-semibold text-slate-700">Status</th>
                </tr>
              </thead>
              <tbody>
                {authorizedEmails.map(email => (
                  <tr key={email} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="p-3 font-medium text-slate-900">{email}</td>
                    <td className="p-3">
                      {currentUser?.email === email ? (
                        <span className="inline-block bg-green-100 text-green-700 px-2 py-1 rounded text-xs font-medium">
                          Currently Logged In
                        </span>
                      ) : (
                        <span className="text-slate-500">Available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default UserManagementTab;
