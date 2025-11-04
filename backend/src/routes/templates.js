// backend/src/routes/templates.js
import express from "express";
const router = express.Router();

// In-memory template data (move to DB if needed)
const templates = [
  {
    id: "card-1",
    name: "Mobile Money → Bank Settlement",
    category: "payments",
    provider: "MTN",
    description: "Automates transfers from mobile wallets into bank accounts.",
    longDesc: "Automates transfers from mobile wallets into bank accounts with real-time reconciliation and API hooks.",
    badge: "Official",
    badgeColor: "purple",
    img: "images/template-1.png",
    imgDark: "images/template-1Dark.png",
    nodes: [
      {id: "start", type: "start", kind: "start", label: "Start", x: 100, y: 100},
      {id: "accHolder", type: "mtn.getAccountHolder", kind: "api", label: "Account Holder", x: 300, y: 100},
      {id: "reqToPay", type: "mtn.requestToPay", kind: "api", label: "Request to Pay", x: 100, y: 200},
      {id: "checkStatus", type: "mtn.checkStatus", kind: "api", label: "Check Status", x: 350, y: 200},
      {id: "getBalance", type: "mtn.getBalance", kind: "api", label: "Get Balance", x: 100, y: 300},
      {id: "end", type: "end", kind: "end", label: "Bank Settlement", x: 350, y: 300}
    ],
    edges: [
      {from: "start", to: "accHolder"},
      {from: "accHolder", to: "reqToPay"},
      {from: "reqToPay", to: "checkStatus"},
      {from: "checkStatus", to: "getBalance"},
      {from: "getBalance", to: "end"}
    ]
  },
  {
    id: "card-2",
    name: "Utility Bills → Core Banking",
    category: "utilities",
    provider: "MTN",
    description: "Handles bill collection and reconciliation into core banking system.",
    longDesc: "Integrates utility payment collections directly into core banking using RESTful APIs.",
    badge: "Community",
    badgeColor: "yellow",
    img: "images/template-2.png",
    imgDark: "images/template-2Dark.png",
    nodes: [
      {id: "start", type: "start", kind: "start", label: "Start", x: 100, y: 100},
      {id: "reqToPay", type: "mtn.requestToPay", kind: "api", label: "Request to Pay", x: 100, y: 200},
      {id: "checkStatus", type: "mtn.checkStatus", kind: "api", label: "Check Status", x: 350, y: 200},
      {id: "getBalance", type: "mtn.getBalance", kind: "api", label: "Get Balance", x: 100, y: 300},
      {id: "end", type: "end", kind: "end", label: "Core Banking", x: 350, y: 300}
    ],
    edges: [
      {from: "start", to: "reqToPay"},
      {from: "reqToPay", to: "checkStatus"},
      {from: "checkStatus", to: "getBalance"},
      {from: "getBalance", to: "end"}
    ]
  },
  {
    id: "card-3",
    name: "Remittance → Wallet",
    category: "remittance",
    provider: "MTN",
    description: "Maps international remittances directly into local mobile wallets.",
    longDesc: "Maps remittances to mobile wallets using AML checks, FX conversions, and partner APIs.",
    badge: "Official",
    badgeColor: "purple",
    img: "images/template-3.png",
    imgDark: "images/template-3Dark.png",
    nodes: [
      {id: "start", type: "start", kind: "start", label: "Start", x: 100, y: 100},
      {id: "accHolder", type: "mtn.getAccountHolder", kind: "api", label: "Account Holder", x: 300, y: 100},
      {id: "reqToPay", type: "mtn.requestToPay", kind: "api", label: "Request to Pay", x: 100, y: 200},
      {id: "checkStatus", type: "mtn.checkStatus", kind: "api", label: "Check Status", x: 350, y: 200},
      {id: "end", type: "end", kind: "end", label: "Wallet", x: 100, y: 300}
    ],
    edges: [
      {from: "start", to: "accHolder"},
      {from: "accHolder", to: "reqToPay"},
      {from: "reqToPay", to: "checkStatus"},
      {from: "checkStatus", to: "end"}
    ]
  },
  {
    id: "card-4",
    name: "Verify Payment",
    category: "payments",
    provider: "FlutterWave",
    description: "Confirms payment have been made.",
    longDesc: "Confirms payment have been made.",
    badge: "Official",
    badgeColor: "purple",
    img: "images/template-4.png",
    imgDark: "images/template-4Dark.png",
    nodes: [
      {id: "start", type: "start", kind: "start", label: "Start", x: 50, y: 100},
      {id: "payment", type: "fW.fWPayment", kind: "api", label: "Payment", x: 250, y: 100},
      {id: "verifyPayment", type: "fW.fWVerifyPayment", kind: "api", label: "Verify Payment", x: 450, y: 100},
      {id: "end", type: "end", kind: "end", label: "End", x: 550, y: 200}
    ],
    edges: [
      {from: "start", to: "payment"},
      {from: "payment", to: "verifyPayment"},
      {from: "verifyPayment", to: "end"}
    ]
  },
  {
    id: "card-5",
    name: "Payment",
    category: "payments",
    provider: "FlutterWave",
    description: "Initiates a one-time payment.",
    longDesc: "Initiates a one-time payment.",
    badge: "Official",
    badgeColor: "purple",
    img: "images/template-5.png",
    imgDark: "images/template-5Dark.png",
    nodes: [
      {id: "start", type: "start", kind: "start", label: "Start", x: 50, y: 100},
      {id: "payment", type: "fW.fWPayment", kind: "api", label: "Payment", x: 250, y: 100},
      {id: "end", type: "end", kind: "end", label: "End", x: 450, y: 100}
    ],
    edges: [
      {from: "start", to: "payment"},
      {from: "payment", to: "end"}
    ]
  }
];

// GET /api/templates
router.get("/", (req, res) => {
  res.json({ templates });
});

export default router;
