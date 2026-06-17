// @ts-nocheck
// GENERATED FILE — DO NOT EDIT BY HAND.
// Precompiled Handlebars specs for the standard-prompt templates, consumed by the
// codegen-free Handlebars runtime so the worker can render them on Cloudflare
// Workers (which forbid runtime code generation).
//
// Regenerate with: pnpm --filter @cat-factory/agents run precompile:templates
// Source templates live in scripts/precompile-prompts.mjs.

/* eslint-disable */

export const blockContext = {"0":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = container.lambda(((stack1 = (depth0 != null ? lookupProperty(depth0,"block") : depth0)) != null ? lookupProperty(stack1,"description") : stack1), depth0)) != null ? stack1 : "");
},"1":function(container,depth0,helpers,partials,data) {
    return "(none provided)";
},"2":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "Target features: "
    + ((stack1 = (lookupProperty(helpers,"join")||(depth0 && lookupProperty(depth0,"join"))||container.hooks.helperMissing).call(depth0 != null ? depth0 : (container.nullContext || {}),(depth0 != null ? lookupProperty(depth0,"features") : depth0),", ",{"name":"join","hash":{},"data":data,"loc":{"start":{"line":4,"column":40},"end":{"line":4,"column":62}}})) != null ? stack1 : "");
},"3":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "Resolved decisions:\n"
    + ((stack1 = lookupProperty(helpers,"each").call(depth0 != null ? depth0 : (container.nullContext || {}),(depth0 != null ? lookupProperty(depth0,"decisions") : depth0),{"name":"each","hash":{},"fn":container.program(4, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":7,"column":0},"end":{"line":8,"column":9}}})) != null ? stack1 : "");
},"4":function(container,depth0,helpers,partials,data) {
    var stack1, helper, alias1=depth0 != null ? depth0 : (container.nullContext || {}), alias2=container.hooks.helperMissing, alias3="function", lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "- "
    + ((stack1 = ((helper = (helper = lookupProperty(helpers,"question") || (depth0 != null ? lookupProperty(depth0,"question") : depth0)) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"question","hash":{},"data":data,"loc":{"start":{"line":7,"column":21},"end":{"line":7,"column":33}}}) : helper))) != null ? stack1 : "")
    + " → "
    + ((stack1 = ((helper = (helper = lookupProperty(helpers,"chosen") || (depth0 != null ? lookupProperty(depth0,"chosen") : depth0)) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"chosen","hash":{},"data":data,"loc":{"start":{"line":7,"column":36},"end":{"line":7,"column":46}}}) : helper))) != null ? stack1 : "")
    + "\n";
},"5":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "Work from earlier agents in this pipeline:\n"
    + ((stack1 = lookupProperty(helpers,"each").call(depth0 != null ? depth0 : (container.nullContext || {}),(depth0 != null ? lookupProperty(depth0,"priorOutputs") : depth0),{"name":"each","hash":{},"fn":container.program(6, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":11,"column":0},"end":{"line":14,"column":9}}})) != null ? stack1 : "");
},"6":function(container,depth0,helpers,partials,data) {
    var stack1, helper, alias1=depth0 != null ? depth0 : (container.nullContext || {}), alias2=container.hooks.helperMissing, alias3="function", lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "### "
    + ((stack1 = ((helper = (helper = lookupProperty(helpers,"agentKind") || (depth0 != null ? lookupProperty(depth0,"agentKind") : depth0)) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"agentKind","hash":{},"data":data,"loc":{"start":{"line":11,"column":26},"end":{"line":11,"column":39}}}) : helper))) != null ? stack1 : "")
    + "\n"
    + ((stack1 = ((helper = (helper = lookupProperty(helpers,"output") || (depth0 != null ? lookupProperty(depth0,"output") : depth0)) != null ? helper : alias2),(typeof helper === alias3 ? helper.call(alias1,{"name":"output","hash":{},"data":data,"loc":{"start":{"line":12,"column":0},"end":{"line":12,"column":10}}}) : helper))) != null ? stack1 : "")
    + "\n\n";
},"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, helper, alias1=depth0 != null ? depth0 : (container.nullContext || {}), alias2=container.lambda, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return "Pipeline: "
    + ((stack1 = ((helper = (helper = lookupProperty(helpers,"pipelineName") || (depth0 != null ? lookupProperty(depth0,"pipelineName") : depth0)) != null ? helper : container.hooks.helperMissing),(typeof helper === "function" ? helper.call(alias1,{"name":"pipelineName","hash":{},"data":data,"loc":{"start":{"line":1,"column":10},"end":{"line":1,"column":26}}}) : helper))) != null ? stack1 : "")
    + "\nBlock: "
    + ((stack1 = alias2(((stack1 = (depth0 != null ? lookupProperty(depth0,"block") : depth0)) != null ? lookupProperty(stack1,"title") : stack1), depth0)) != null ? stack1 : "")
    + " ("
    + ((stack1 = alias2(((stack1 = (depth0 != null ? lookupProperty(depth0,"block") : depth0)) != null ? lookupProperty(stack1,"type") : stack1), depth0)) != null ? stack1 : "")
    + ")\nDescription: "
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,((stack1 = (depth0 != null ? lookupProperty(depth0,"block") : depth0)) != null ? lookupProperty(stack1,"description") : stack1),{"name":"if","hash":{},"fn":container.program(0, data, 0),"inverse":container.program(1, data, 0),"data":data,"loc":{"start":{"line":3,"column":13},"end":{"line":3,"column":89}}})) != null ? stack1 : "")
    + "\n"
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,((stack1 = (depth0 != null ? lookupProperty(depth0,"features") : depth0)) != null ? lookupProperty(stack1,"length") : stack1),{"name":"if","hash":{},"fn":container.program(2, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":4,"column":0},"end":{"line":4,"column":69}}})) != null ? stack1 : "")
    + "\n"
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,((stack1 = (depth0 != null ? lookupProperty(depth0,"decisions") : depth0)) != null ? lookupProperty(stack1,"length") : stack1),{"name":"if","hash":{},"fn":container.program(3, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":5,"column":0},"end":{"line":8,"column":16}}})) != null ? stack1 : "")
    + "\n"
    + ((stack1 = lookupProperty(helpers,"if").call(alias1,((stack1 = (depth0 != null ? lookupProperty(depth0,"priorOutputs") : depth0)) != null ? lookupProperty(stack1,"length") : stack1),{"name":"if","hash":{},"fn":container.program(5, data, 0),"inverse":container.noop,"data":data,"loc":{"start":{"line":9,"column":0},"end":{"line":14,"column":16}}})) != null ? stack1 : "");
},"useData":true}

export const design = {"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = container.invokePartial(lookupProperty(partials,"blockContext"),depth0,{"name":"blockContext","data":data,"helpers":helpers,"partials":partials,"decorators":container.decorators})) != null ? stack1 : "")
    + "Produce the solution design for this block. Be concise and concrete: prefer short bullets over prose, and finish with the ordered implementation steps.";
},"usePartial":true,"useData":true}

export const build = {"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = container.invokePartial(lookupProperty(partials,"blockContext"),depth0,{"name":"blockContext","data":data,"helpers":helpers,"partials":partials,"decorators":container.decorators})) != null ? stack1 : "")
    + "Produce the implementation for this block, faithful to the design and prior work above: the key modules, functions, data shapes and wiring.";
},"usePartial":true,"useData":true}

export const review = {"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = container.invokePartial(lookupProperty(partials,"blockContext"),depth0,{"name":"blockContext","data":data,"helpers":helpers,"partials":partials,"decorators":container.decorators})) != null ? stack1 : "")
    + "Review the work above. List concrete, actionable findings ordered by severity; if it is sound, say so explicitly.";
},"usePartial":true,"useData":true}

export const test = {"compiler":[8,">= 4.3.0"],"main":function(container,depth0,helpers,partials,data) {
    var stack1, lookupProperty = container.lookupProperty || function(parent, propertyName) {
        if (Object.prototype.hasOwnProperty.call(parent, propertyName)) {
          return parent[propertyName];
        }
        return undefined
    };

  return ((stack1 = container.invokePartial(lookupProperty(partials,"blockContext"),depth0,{"name":"blockContext","data":data,"helpers":helpers,"partials":partials,"decorators":container.decorators})) != null ? stack1 : "")
    + "Produce a pragmatic test plan for this block: the highest-value tests to write first, the key edge cases and the failure modes to cover.";
},"usePartial":true,"useData":true}
