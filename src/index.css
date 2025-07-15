
@tailwind base;
    @tailwind components;
    @tailwind utilities;

    @layer base {
      :root {
        --background: 240 5.2% 98%; /* Light Gray */
        --foreground: 222.2 84% 4.9%; /* Dark Blue/Black */
        --card: 255 100% 100%;
        --card-foreground: 222.2 84% 4.9%;
        --popover: 255 100% 100%;
        --popover-foreground: 222.2 84% 4.9%;
        --primary: 222.2 47.4% 11.2%;
        --primary-foreground: 210 40% 98%;
        --secondary: 210 40% 96.1%;
        --secondary-foreground: 222.2 47.4% 11.2%;
        --muted: 210 40% 96.1%;
        --muted-foreground: 215.4 16.3% 46.9%;
        --accent: 210 40% 96.1%;
        --accent-foreground: 222.2 47.4% 11.2%;
        --destructive: 0 84.2% 60.2%;
        --destructive-foreground: 210 40% 98%;
        --border: 214.3 31.8% 91.4%;
        --input: 214.3 31.8% 91.4%;
        --ring: 222.2 84% 4.9%;
        --radius: 0.5rem; /* Adjusted for a slightly less rounded look */
      }

      .dark {
        /* You can define dark mode colors here if needed later */
      }
    }

    body {
      @apply bg-background text-foreground;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    * {
      @apply border-border;
    }

    /* Custom scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
    }

    ::-webkit-scrollbar-track {
      @apply bg-gray-100 rounded-lg;
    }

    ::-webkit-scrollbar-thumb {
      @apply bg-gray-300 rounded-lg hover:bg-gray-400;
    }

    .form-label {
        @apply block text-sm font-medium text-gray-700 mb-1;
    }

    .form-input {
        @apply w-full px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-tabarnam-blue transition-colors;
    }

    input:focus,
    input:focus-visible {
      outline: none !important;
      box-shadow: none !important;
      border-color: transparent !important;
    }

    @media (max-width: 767px) {
      .search-bar {
        display: flex;
        flex-direction: column;
        gap: 16px;
        width: 100%;
      }

      .search-bar .search-bar-row {
        display: contents; /* Allows grid items to be direct children of the flex container */
      }
      
      .search-bar-row > * {
        width: 100%;
      }
    }

    .search-bar {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
