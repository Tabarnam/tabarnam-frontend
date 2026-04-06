import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-muted border-t border-border pt-4 pb-8">
      <div className="max-w-5xl mx-auto text-center">
        <p className="text-xs text-muted-foreground">
          Est 2016. Copyright © {new Date().getFullYear()} Tabarnam. All rights reserved
        </p>
      </div>
    </footer>
  );
};

export default Footer;
