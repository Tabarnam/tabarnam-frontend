import React from 'react';

const Footer = () => {
  return (
    <footer className="footer-legal bg-gray-100 border-t border-gray-200 mt-12">
      <div className="w-full py-8 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <p className="text-sm font-semibold text-gray-900 mb-4">
            Tabarnam™ - All rights reserved.
          </p>
          
          <div className="text-xs text-gray-600 space-y-2">
            <p>
              Copyright © 2025 Tabarnam. All rights reserved.
            </p>
            
            <p>
              <strong>Disclaimer:</strong> The information on this site is for general purposes only and does not constitute professional advice. Tabarnam is not liable for any errors, omissions, or losses from use. Consult a qualified professional for specific advice.
            </p>
            
            <p>
              <strong>Trademark:</strong> Tabarnam™ is a trademark of Tabarnam Inc. in the process of registration. Unauthorized use prohibited.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
