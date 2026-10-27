/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: {
      path: "node_modules|generated|dist"
    },
    tsConfig: {
      fileName: "./tsconfig.json"
    }
  }
};
