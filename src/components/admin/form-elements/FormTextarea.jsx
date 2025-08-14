import React from 'react';

const FormTextarea = ({ label, ...props }) => (
    <div>
        <label htmlFor={props.name} className="form-label">{label}</label>
        <textarea id={props.name} {...props} rows="3" className="form-input" />
    </div>
);

export default FormTextarea;