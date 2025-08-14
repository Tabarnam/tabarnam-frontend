import React from 'react';

const FormInput = ({ label, ...props }) => (
    <div>
        <label htmlFor={props.name} className="form-label">{label}</label>
        <input id={props.name} {...props} className="form-input" />
    </div>
);

export default FormInput;