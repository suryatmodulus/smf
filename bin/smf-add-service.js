const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const prompt = require('prompt');
const util = require('util');

const config = require('./config');
const configClients = require('./config-clients');
const configServices = require('./config-services');
const serviceProps = require('./service-props');
const utils = require('./utils');
const validators = require('./validators');

const promptGetAsync = util.promisify(prompt.get);

async function addService() {
  if (!process.argv[4]) {
    console.error('Service name not specified');
    return;
  }

  const serviceName = process.argv[4];

  if (!validators.IsGenericNameValid(serviceName)) {
    return;
  }

  console.info(`Creating new service: ${serviceName}`);

  const dirName = `./services/${serviceName}`;

  if (fs.existsSync(dirName)) {
    console.error(`Directory already exists: ${dirName}`);
    return;
  }

  const smfRoot = utils.smfDir();

  const properties = [
    {
      name: 'number',
      description: 'Type the number',
      validator: /^[0-9]+$/,
      warning: 'Digits only',
      required: true,
    }
  ];
  
  let input;
  
  //========== select template ==================================================
  const allTemplates = configServices.ALL;

  console.info('');
  utils.hr();
  console.info(`Select service template:`);

  prompt.start();

  for (const i in allTemplates) {
    const template = allTemplates[i];
    formatTemplate(Number(i) + 1, template.name);
  }

  try {
    input = await promptGetAsync(properties);
  }
  catch(err) {
    console.info('');
    return /* console.error(err) */;
  }

  const selectedTemplate = allTemplates[input.number - 1];

  //========== set props =======================================================
  const props = [];

  // init default props
  props.push({
    name: 'PROJECT',
    value: serviceProps.projectName(),
  });

  // query custom props
  if (selectedTemplate.props) {
    for (const prop of selectedTemplate.props) {
      console.info('');
      console.info(`${prop.prompt}:`);
      const value = await prop.func();

      if (!value) return;

      props.push({
        name: prop.name,
        value,
      });
    };
  }

  // console.info(props);

  //========== select clients ==================================================
  const selectedClients = [];

  if (selectedTemplate.selectClients) {
    const allClients = configClients.ALL;
  
    console.info('');
    utils.hr();
    console.info(`Select third-party services clients that your service "${serviceName}" connects to (one at a time),`);
    console.info("(don't forget to select one of the message broker clients if you want your services communicate with each other):");
  
    prompt.start();
  
    do {
      formatClient(0, 'exit selection');
  
      for (const i in allClients) {
        const client = allClients[i];
        formatClient(Number(i) + 1, `(${client.category}) ${client.name}`);
      }
  
      try {
        input = await promptGetAsync(properties);
        // console.info(input);
      }
      catch(err) {
        console.info('');
        return /* console.error(err) */;
      }
  
      if (input.number !== '0') {
        const selectedClient = allClients[input.number - 1];
  
        if (!selectedClient) {
          console.error(`No client for option ${input.number}`);
        }
        else {
          // console.info(selectedClient);
          if (!selectedClients.includes(selectedClient)) {
            selectedClients.push(selectedClient);
          }
        }
  
        console.info('');
        console.info('Selected clients: ');
        console.info(`[${selectedClients.map(client => client.name).join(', ')}]`);
        console.info('Select another client: ');
        console.info('');
      }
    }
    while (input.number !== '0');
  }
  
  //=============================================================================
  fs.mkdirSync(dirName, {recursive: true});

  //========== before create =====================================================
  if (selectedTemplate.beforeCreate) {
    utils.hr();
    console.info('Running beforeCreate commands....');

    for (let i = 0; i < selectedTemplate.beforeCreate.length; i++) {
      const command = selectedTemplate.beforeCreate[i];
      console.info('----------------------------------');
      console.info(`run: ${command.cmd}`);

      utils.exec(command.cmd, {
        cwd: `./${dirName}${command.dir || ''}`,
      });  
    }
  }

  //========== copy content =====================================================
  utils.hr();
  console.info('Copying components...');

  await utils.copyFilesRootAsync(`templates/add-service/${selectedTemplate.id}/**/*`, `./${dirName}`, 3);
  updatePackageJson(`${dirName}/package.json`, {
    serviceName,
  });

  //========== service props =====================================================
  utils.hr();
  console.info('Updating service properties...');
  serviceProps.replaceProps(dirName, props);

  //========== update project config ========================
  let serviceAttrs;
  let serviceEnv;
  let deployAttrs;

  const templateConfigFile = `${dirName}/${config.STACK_SERVICE_TEMPLATE_MANIFEST}`;
  if (fs.existsSync(templateConfigFile)) {
    const data = fs.readFileSync(templateConfigFile);
    const json = JSON.parse(data);

    serviceAttrs = json['smf-stack'];
    serviceEnv   = json['smf-env'];
    deployAttrs  = json['smf-deploy'];

    fs.unlinkSync(templateConfigFile);
  }
    
  updateStackConfig(`./${config.STACK_CONFIG}`, {
    serviceName,
    serviceAttrs,
    clients: selectedClients,
  });

  if (serviceEnv && serviceEnv.vars) {
    // sync stack & env configs
    const data = fs.readFileSync(`./${config.STACK_CONFIG}`);
    const json = JSON.parse(data);  
    utils.updateStackEnvFile(json);  
  
    updateEnvConfig(`./${config.STACK_ENV}`, {
      serviceName,
      vars: serviceEnv.vars,
    });
    
    if (serviceEnv.debugEnvFile) {
      const vars = utils.convertBuildVars(serviceEnv.vars);
      utils.createEnvFile(`${dirName}${serviceEnv.debugEnvFile}`, vars);
    }
  }

  if (deployAttrs) {
    updateDeployConfig(`./${config.STACK_DEPLOY}`, deployAttrs);
  }

  //========== generate client usage code ======================================
  utils.hr();
  console.info('Generate client usage demo code...');

  const codeHeader = [];
  const codeBody   = [];

  for (const client of selectedClients) {
    const usageFileName = `${smfRoot}/core/clients/${client.id}/${config.STACK_USAGE_EXAMPLE}`;
    console.info(usageFileName);
    if (fs.existsSync(usageFileName)) {
      const data = fs.readFileSync(usageFileName, 'utf8');
      const lines = data.trim().split("\n");

      codeBody.push('');
      codeBody.push(`//========== ${client.name} ==========`);

      clientCodeBody = [];

      for (const l of lines) {
        if (l.startsWith('import')) {
          if (!codeHeader.includes(l)) codeHeader.push(l)
        }
        else clientCodeBody.push(l);
      }

      if (clientCodeBody.length > 0 && clientCodeBody[0].trim() === '') clientCodeBody.shift();

      clientCodeBodyScoped = clientCodeBody.map(l => `  ${l}`);
      clientCodeBodyScoped.unshift('{');
      clientCodeBodyScoped.push('}');

      codeBody.push(...clientCodeBodyScoped);
    }
  }

  if (codeHeader.length > 0 || codeBody.length > 0) {
    updateMain(`./${dirName}/main.ts`, codeHeader, codeBody);
  }  

  //========== npm install ===============================================
  console.info('Running "npm install"...');
  utils.exec('npm install', {
    cwd: `./${dirName}`,
  });

  //========== cleanup ============================================
  utils.hr();
  console.info('Cleaning up...');
  cleanup(dirName);

  //========== info ===============================================
  utils.hr();
  console.info(`Success! Created ${serviceName} service in ${fs.realpathSync(dirName)}`);
  console.info('');
  console.info('We suggest that you continue by typing');
  console.info('');
  console.info(`\t smf up - to see how the demo code is working`);
  console.info(`\t cd .${path.sep}services${path.sep}${serviceName}`);
  console.info(`\t (start coding: install new libs using npm install <...>, edit main.ts file, etc.)`);
  console.info('');
}

function formatClient(number, name) {
  console.info(`${number/*.toString().padStart(2, '0')*/}) ${name}`);
}

function formatTemplate(number, name) {
  console.info(`${number}) ${name}`);
}

function updatePackageJson(fileName, options) {
  const data = fs.readFileSync(fileName);
  const json = JSON.parse(data);

  json.name        = options.serviceName;
  json.description = '';
  json.author      = '';
  json.license     = '';

  fs.writeFileSync(fileName, JSON.stringify(json, null, 2));
}

function updateStackConfig(fileName, options) {
  const data = fs.readFileSync(fileName);
  const json = JSON.parse(data);

  json.services[options.serviceName] = {
    ...options.serviceAttrs,
    clients: {}
  }

  if (!json.clients) json.clients = {}

  for (const client of options.clients) {
    json.services[options.serviceName].clients[client.id] = {}
    json.clients[client.id] = {external: false}
  }

  fs.writeFileSync(fileName, JSON.stringify(json, null, 2));
}

function updateEnvConfig(fileName, options) {
  const data = fs.readFileSync(fileName);
  const json = JSON.parse(data);

  json.services[options.serviceName] = {
    ...options.vars,
  }

  fs.writeFileSync(fileName, JSON.stringify(json, null, 2));
}

function updateDeployConfig(fileName, options) {
  const data = fs.readFileSync(fileName);
  const json = JSON.parse(data);

  json.env = {
    ...json.env,
    ...options.env,
  }

  fs.writeFileSync(fileName, JSON.stringify(json, null, 2));
}

function updateMain(fileName, codeHeader, codeBody) {
  const data = fs.readFileSync(fileName, 'utf8');

  if (data.includes(config.SERVICE_CLIENT_USAGE_CODE)) {
    const lines = data.split("\n");

    let indent = '';

    for (l of lines) {
      if (l.includes(config.SERVICE_CLIENT_USAGE_CODE)) {
        indent = l.replace(config.SERVICE_CLIENT_USAGE_CODE, '').replace("\n", '');
        break;
      }
    }

    const codeBodyIndented = codeBody.map(l => `${indent}${l}`);
    // codeBodyIndented.unshift(`${indent}{`);
    // codeBodyIndented.push(`${indent}}`);
  
    let newContent = data
      .replace(config.SERVICE_IMPORTS, codeHeader.join("\n"))
      .replace(`${indent}${config.SERVICE_CLIENT_USAGE_CODE}`, codeBodyIndented.join("\n"));
  
    fs.writeFileSync(fileName, newContent);
  }
}

function cleanup(dir) {
  const exclude = [];
  const removeDirs = ['.git'];
  const files = fs.readdirSync(dir);

  files.forEach(name => {
    if (exclude.includes(name)) return;

    const file = path.join(dir, name);
    
    if (removeDirs.includes(name)) {
      // console.info(`Remove: ${file}`);
      fse.removeSync(file);
    }
    else {
      if (fs.lstatSync(file).isDirectory()) {
        cleanup(file);
      }
    }
  });
}

module.exports = addService;