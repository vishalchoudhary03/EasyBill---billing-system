# EasyBill – Smart Kirana Billing and Inventory Management System

EasyBill is a web-based billing and inventory management application designed to simplify daily billing operations, product management, stock tracking, and payment management for small retail shops and kirana stores.

The application uses Firebase Authentication for user login and Cloud Firestore to store user-specific billing and inventory data.

## Live Project: https://bill-7486c.web.app/

## Features

### 1. User Authentication
- User login using Firebase Authentication.
- Password reset functionality.
- User-specific data management.

### 2. Billing System
- Create customer bills.
- Add products and specify quantities.
- Automatically calculate bill totals.
- Apply tax/GST and discounts.
- Track paid amounts and outstanding balances.

### 3. Product Management
- Add new products.
- Edit existing product details.
- Manage product names, units, quantities, and prices.

### 4. Inventory and Stock Management
- Manage available stock and product quantities.
- Track inventory alongside billing operations.

### 5. Bill History
- View previously saved bills.
- Search bills by customer name.
- Filter bill records by date.
- Review bill totals, payments, and outstanding dues.

### 6. Due and Payment Management
- Identify bills with outstanding dues.
- Record payments against outstanding balances.
- Track remaining amounts due.

### 7. PDF Generation and Printing
- Generate downloadable PDF receipts.
- Print customer bills.
- Display item details, quantities, prices, and totals.

### 8. WhatsApp Bill Sharing
- Share bill details with customers through WhatsApp.
- Include bill totals, paid amounts, and outstanding balances in the message.

### 9. Recycle Bin
- Manage deleted items through the Recycle Bin.
- Restore deleted items where supported.
- Automatically and permanently delete items after 7 days if they remain in the Recycle Bin.

### 10. User Interface
- Responsive interface for mobile and desktop screens.
- Dark and light theme options.
- Installable web app support where supported by the browser.

## Technology Stack

| Technology | Purpose |
|---|---|
| HTML5 | Application structure |
| CSS3 | Styling and responsive design |
| JavaScript | Application logic and interactions |
| Firebase Authentication | User authentication |
| Cloud Firestore | Billing, product, history, and inventory data |
| jsPDF | PDF bill generation |
| Service Worker | Supported PWA functionality |

## Project Structure

EasyBill/
├── index.html
├── style.css
├── app.js
├── firebase.json
├── manifest.json
├── sw.js
└── README.md

## Firebase and Data Security

- Firebase Authentication handles user login.
- User data is organized using Firebase Authentication UIDs.
- Firestore Security Rules should restrict users to their own data.
- Validate incoming data through appropriate Firestore Security Rules.
- Firebase App Check can help reduce unauthorized client abuse.

**Security precautions:**
- Never upload service-account private keys, passwords, or sensitive credentials.
- Do not upload real customer bills or private user data to a public repository.
- Protect database access through Authentication and Firestore Security Rules.
- Monitor Firebase usage for unexpected activity.

## Usage

1. Sign in using a valid account.
2. Add or manage products.
3. Enter customer details and select products.
4. Specify quantities and prices to prepare a bill.
5. Apply tax or discounts when needed.
6. Save the bill and manage payment records.
7. Generate a PDF, print the bill, or share it through WhatsApp.
8. Review previous transactions in Bill History.
9. Manage inventory and deleted items through Stock and Recycle Bin.

## Future Enhancements

- Sales reports and analytics.
- Improved inventory alerts.
- Enhanced security and data validation.
- Additional billing and payment reports.
- Further improvements to mobile usability.

## Author

**Vishal Choudhary**

GitHub: [vishalchoudhary03](https://github.com/vishalchoudhary03)

## License

No license has currently been specified for this repository. All rights are reserved by default unless a license is added.
