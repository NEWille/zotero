/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2012 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Portions of this file are derived from Special Powers code,
    Copyright (C) 2010 Mozilla Corporation. All Rights Reserved.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

const BOMs = {
	"UTF-8":"\xEF\xBB\xBF",
	"UTF-16BE":"\xFE\xFF",
	"UTF-16LE":"\xFF\xFE",
	"UTF-32BE":"\x00\x00\xFE\xFF",
	"UTF-32LE":"\xFF\xFE\x00\x00"
}

Components.utils.import("resource://gre/modules/NetUtil.jsm");

Zotero.Translate.DOMWrapper = new function() {
	
	/*
	 * BEGIN SPECIAL POWERS WRAPPING CODE
	 * https://mxr.mozilla.org/mozilla-central/source/testing/mochitest/tests/SimpleTest/specialpowersAPI.js?raw=1
	 */
	function isWrappable(x) {
		if (typeof x === "object")
			return x !== null;
		return typeof x === "function";
	};
	
	function isWrapper(x) {
		return isWrappable(x) && (typeof x.SpecialPowers_wrappedObject !== "undefined");
	};
	
	function unwrapIfWrapped(x) {
		return isWrapper(x) ? unwrapPrivileged(x) : x;
	};
	
	function isXrayWrapper(x) {
		return /XrayWrapper/.exec(x.toString());
	}
	
	// We can't call apply() directy on Xray-wrapped functions, so we have to be
	// clever.
	function doApply(fun, invocant, args) {
		return Function.prototype.apply.call(fun, invocant, args);
	}

	function wrapPrivileged(obj) {
	
		// Primitives pass straight through.
		if (!isWrappable(obj))
			return obj;
	
		// No double wrapping.
		if (isWrapper(obj))
			throw "Trying to double-wrap object!";
	
		// Make our core wrapper object.
		var handler = new SpecialPowersHandler(obj);
	
		// If the object is callable, make a function proxy.
		if (typeof obj === "function") {
			var callTrap = function() {
				// The invocant and arguments may or may not be wrappers. Unwrap them if necessary.
				var invocant = unwrapIfWrapped(this);
				var unwrappedArgs = Array.prototype.slice.call(arguments).map(unwrapIfWrapped);
	
				return wrapPrivileged(doApply(obj, invocant, unwrappedArgs));
			};
			var constructTrap = function() {
				// The arguments may or may not be wrappers. Unwrap them if necessary.
				var unwrappedArgs = Array.prototype.slice.call(arguments).map(unwrapIfWrapped);
	
				// Constructors are tricky, because we can't easily call apply on them.
				// As a workaround, we create a wrapper constructor with the same
				// |prototype| property.
				var FakeConstructor = function() {
					doApply(obj, this, unwrappedArgs);
				};
				FakeConstructor.prototype = obj.prototype;
	
				return wrapPrivileged(new FakeConstructor());
			};
	
			return Proxy.createFunction(handler, callTrap, constructTrap);
		}
	
		// Otherwise, just make a regular object proxy.
		return Proxy.create(handler);
	};
	
	function unwrapPrivileged(x) {
	
		// We don't wrap primitives, so sometimes we have a primitive where we'd
		// expect to have a wrapper. The proxy pretends to be the type that it's
		// emulating, so we can just as easily check isWrappable() on a proxy as
		// we can on an unwrapped object.
		if (!isWrappable(x))
			return x;
	
		// If we have a wrappable type, make sure it's wrapped.
		if (!isWrapper(x))
			throw "Trying to unwrap a non-wrapped object!";
	
		// Unwrap.
		return x.SpecialPowers_wrappedObject;
	};
	
	function crawlProtoChain(obj, fn) {
		var rv = fn(obj);
		if (rv !== undefined)
			return rv;
		if (Object.getPrototypeOf(obj))
			return crawlProtoChain(Object.getPrototypeOf(obj), fn);
	};
	
	
	function SpecialPowersHandler(obj) {
		this.wrappedObject = obj;
	};
	
	// Allow us to transitively maintain the membrane by wrapping descriptors
	// we return.
	SpecialPowersHandler.prototype.doGetPropertyDescriptor = function(name, own) {
	
		// Handle our special API.
		if (name == "SpecialPowers_wrappedObject")
			return { value: this.wrappedObject, writeable: false, configurable: false, enumerable: false };
	
		// In general, we want Xray wrappers for content DOM objects, because waiving
		// Xray gives us Xray waiver wrappers that clamp the principal when we cross
		// compartment boundaries. However, Xray adds some gunk to toString(), which
		// has the potential to confuse consumers that aren't expecting Xray wrappers.
		// Since toString() is a non-privileged method that returns only strings, we
		// can just waive Xray for that case.
		var obj = name == 'toString' ? XPCNativeWrapper.unwrap(this.wrappedObject)
																 : this.wrappedObject;
	
		//
		// Call through to the wrapped object.
		//
		// Note that we have several cases here, each of which requires special handling.
		//
		var desc;
	
		// Case 1: Own Properties.
		//
		// This one is easy, thanks to Object.getOwnPropertyDescriptor().
		if (own)
			desc = Object.getOwnPropertyDescriptor(obj, name);
	
		// Case 2: Not own, not Xray-wrapped.
		//
		// Here, we can just crawl the prototype chain, calling
		// Object.getOwnPropertyDescriptor until we find what we want.
		//
		// NB: Make sure to check this.wrappedObject here, rather than obj, because
		// we may have waived Xray on obj above.
		else if (!isXrayWrapper(this.wrappedObject))
			try {
				desc = crawlProtoChain(obj, function(o) {return Object.getOwnPropertyDescriptor(o, name);});
			} catch(e) {
				// we hit bug 560072 if DOM is not wrapped
				// https://bugzilla.mozilla.org/show_bug.cgi?id=560072
				if (name in obj) {
					// same guess as below
					desc = {value: obj[name], writable: false, configurable: true, enumerable: true};
				}
			}
	
		// Case 3: Not own, Xray-wrapped.
		//
		// This one is harder, because we Xray wrappers are flattened and don't have
		// a prototype. Xray wrappers are proxies themselves, so we'd love to just call
		// through to XrayWrapper<Base>::getPropertyDescriptor(). Unfortunately though,
		// we don't have any way to do that. :-(
		//
		// So we first try with a call to getOwnPropertyDescriptor(). If that fails,
		// we make up a descriptor, using some assumptions about what kinds of things
		// tend to live on the prototypes of Xray-wrapped objects.
		else {
			desc = Object.getOwnPropertyDescriptor(obj, name);
			if (!desc) {
				var getter = Object.prototype.__lookupGetter__.call(obj, name);
				var setter = Object.prototype.__lookupSetter__.call(obj, name);
				if (getter || setter)
					desc = {get: getter, set: setter, configurable: true, enumerable: true};
				else if (name in obj)
					desc = {value: obj[name], writable: false, configurable: true, enumerable: true};
			}
		}
	
		// Bail if we've got nothing.
		if (typeof desc === 'undefined')
			return undefined;
	
		// When accessors are implemented as JSPropertyOps rather than JSNatives (ie,
		// QuickStubs), the js engine does the wrong thing and treats it as a value
		// descriptor rather than an accessor descriptor. Jorendorff suggested this
		// little hack to work around it. See bug 520882.
		if (desc && 'value' in desc && desc.value === undefined)
			desc.value = obj[name];
	
		// A trapping proxy's properties must always be configurable, but sometimes
		// this we get non-configurable properties from Object.getOwnPropertyDescriptor().
		// Tell a white lie.
		desc.configurable = true;
	
		// Transitively maintain the wrapper membrane.
		function wrapIfExists(key) { if (key in desc) desc[key] = wrapPrivileged(desc[key]); };
		wrapIfExists('value');
		wrapIfExists('get');
		wrapIfExists('set');
	
		return desc;
	};
	
	SpecialPowersHandler.prototype.getOwnPropertyDescriptor = function(name) {
		return this.doGetPropertyDescriptor(name, true);
	};
	
	SpecialPowersHandler.prototype.getPropertyDescriptor = function(name) {
		return this.doGetPropertyDescriptor(name, false);
	};
	
	function doGetOwnPropertyNames(obj, props) {
	
		// Insert our special API. It's not enumerable, but getPropertyNames()
		// includes non-enumerable properties.
		var specialAPI = 'SpecialPowers_wrappedObject';
		if (props.indexOf(specialAPI) == -1)
			props.push(specialAPI);
	
		// Do the normal thing.
		var flt = function(a) { return props.indexOf(a) == -1; };
		props = props.concat(Object.getOwnPropertyNames(obj).filter(flt));
	
		// If we've got an Xray wrapper, include the expandos as well.
		if ('wrappedJSObject' in obj)
			props = props.concat(Object.getOwnPropertyNames(obj.wrappedJSObject)
													 .filter(flt));
	
		return props;
	}
	
	SpecialPowersHandler.prototype.getOwnPropertyNames = function() {
		return doGetOwnPropertyNames(this.wrappedObject, []);
	};
	
	SpecialPowersHandler.prototype.getPropertyNames = function() {
	
		// Manually walk the prototype chain, making sure to add only property names
		// that haven't been overridden.
		//
		// There's some trickiness here with Xray wrappers. Xray wrappers don't have
		// a prototype, so we need to unwrap them if we want to get all of the names
		// with Object.getOwnPropertyNames(). But we don't really want to unwrap the
		// base object, because that will include expandos that are inaccessible via
		// our implementation of get{,Own}PropertyDescriptor(). So we unwrap just
		// before accessing the prototype. This ensures that we get Xray vision on
		// the base object, and no Xray vision for the rest of the way up.
		var obj = this.wrappedObject;
		var props = [];
		while (obj) {
			props = doGetOwnPropertyNames(obj, props);
			obj = Object.getPrototypeOf(XPCNativeWrapper.unwrap(obj));
		}
		return props;
	};
	
	SpecialPowersHandler.prototype.defineProperty = function(name, desc) {
		return Object.defineProperty(this.wrappedObject, name, desc);
	};
	
	SpecialPowersHandler.prototype.delete = function(name) {
		return delete this.wrappedObject[name];
	};
	
	SpecialPowersHandler.prototype.fix = function() { return undefined; /* Throws a TypeError. */ };
	
	// Per the ES5 spec this is a derived trap, but it's fundamental in spidermonkey
	// for some reason. See bug 665198.
	SpecialPowersHandler.prototype.enumerate = function() {
		var t = this;
		var filt = function(name) { return t.getPropertyDescriptor(name).enumerable; };
		return this.getPropertyNames().filter(filt);
	};
	/*
	 * END SPECIAL POWERS WRAPPING CODE
	 */
	
	/**
	 * Abstracts DOM wrapper support for avoiding XOWs<br/>
	 * In Firefox 3.6, we use FX36DOMWrapper, defined below<br/>
	 * In Firefox 4+, we use some proxy code taken from Special Powers
	 * @param {XPCCrossOriginWrapper} obj
	 * @return {Object} An obj that is no longer Xrayed
	 */
	this.wrap = function(obj) {
		var newObj = wrapPrivileged(obj);
		return newObj;
	}
	
	/**
	 * Unwraps an object
	 */
	this.unwrap = function(obj) {
		if("__wrappedDOMObject" in obj) {
			return obj.__wrappedDOMObject;
		} else if(isWrapper(obj)) {
			return unwrapPrivileged(obj);
		} else {
			return obj;
		}
	}
	
	/**
	 * Checks whether an object is wrapped by a DOM wrapper
	 * @param {XPCCrossOriginWrapper} obj
	 * @return {Boolean} Whether or not the object is wrapped
	 */
	this.isWrapped = function(obj) {
		return "__wrappedDOMObject" in obj || isWrapper(obj);
	}
}

/**
 * @class Manages the translator sandbox
 * @param {Zotero.Translate} translate
 * @param {String|window} sandboxLocation
 */
Zotero.Translate.SandboxManager = function(sandboxLocation) {
	this.sandbox = new Components.utils.Sandbox(sandboxLocation);
	this.sandbox.Zotero = {};
	
	// import functions missing from global scope into Fx sandbox
	this.sandbox.XPathResult = Components.interfaces.nsIDOMXPathResult;
	if(typeof sandboxLocation === "object" &&
			("wrappedJSObject" in sandboxLocation
			? "DOMParser" in sandboxLocation.wrappedJSObject
			: "DOMParser" in sandboxLocation)) {
		this.sandbox.DOMParser = "wrappedJSObject" in sandboxLocation
			? sandboxLocation.wrappedJSObject.DOMParser : sandboxLocation.DOMParser;
	} else {
		this.sandbox.DOMParser = function() {
			// get URI
			// DEBUG: In Fx 4 we can just use document.nodePrincipal, but in Fx 3.6 this doesn't work
			if(typeof sandboxLocation === "string") {	// if sandbox specified by URI
				var uri = sandboxLocation;
			} else {									// if sandbox specified by DOM document
				var uri = sandboxLocation.location.toString();
			}
			
			// get from nsIURI
			var ioService = Components.classes["@mozilla.org/network/io-service;1"]
				.getService(Components.interfaces.nsIIOService);
			uri = ioService.newURI(uri, "UTF-8", null);
			
			if(typeof sandboxLocation === "object" && sandboxLocation.nodePrincipal) {
				// if sandbox specified by DOM document, use nodePrincipal property
				var principal = sandboxLocation.nodePrincipal;
			} else {
				// if sandbox specified by URI, get codebase principal from security manager
				var secMan = Components.classes["@mozilla.org/scriptsecuritymanager;1"]
						.getService(Components.interfaces.nsIScriptSecurityManager);
				var principal = secMan.getCodebasePrincipal(uri);
			}
			
			// initialize DOM parser
			var _DOMParser = Components.classes["@mozilla.org/xmlextras/domparser;1"]
				.createInstance(Components.interfaces.nsIDOMParser);
			_DOMParser.init(principal, uri, uri);
			
			// expose parseFromString
			this.__exposedProps__ = {"parseFromString":"r"};
			if(Zotero.isFx5) {
				this.parseFromString = function(str, contentType) {
					return Zotero.Translate.DOMWrapper.wrap(_DOMParser.parseFromString(str, contentType));
				}
			} else {
				this.parseFromString = function(str, contentType) _DOMParser.parseFromString(str, contentType);
			}
		}
	};
	this.sandbox.DOMParser.__exposedProps__ = {"prototype":"r"};
	this.sandbox.DOMParser.prototype = {};
	this.sandbox.XMLSerializer = function() {
		var s = Components.classes["@mozilla.org/xmlextras/xmlserializer;1"]
			.createInstance(Components.interfaces.nsIDOMSerializer);
		this.serializeToString = function(doc) {
			return s.serializeToString(Zotero.Translate.DOMWrapper.unwrap(doc));
		};
	};
}

Zotero.Translate.SandboxManager.prototype = {
	/**
	 * Evaluates code in the sandbox
	 */
	"eval":function(code, exported, path) {
		Components.utils.evalInSandbox(code, this.sandbox, "1.8", path, 1);
	},
	
	/**
	 * Imports an object into the sandbox
	 *
	 * @param {Object} object Object to be imported (under Zotero)
	 * @param {Boolean} passTranslateAsFirstArgument Whether the translate instance should be passed
	 *     as the first argument to the function.
	 */
	"importObject":function(object, passAsFirstArgument, attachTo) {
		if(!attachTo) attachTo = this.sandbox.Zotero;
		var newExposedProps = false;
		if(!object.__exposedProps__) newExposedProps = {};
		for(var key in (newExposedProps ? object : object.__exposedProps__)) {
			let localKey = key;
			if(newExposedProps) newExposedProps[localKey] = "r";
			
			var type = typeof object[localKey];
			var isFunction = type === "function";
			var isObject = typeof object[localKey] === "object";
			if(isFunction || isObject) {
				if(isFunction) {
					if(passAsFirstArgument) {
						attachTo[localKey] = object[localKey].bind(object, passAsFirstArgument);
					} else {
						attachTo[localKey] = object[localKey].bind(object);
					}
				} else {
					attachTo[localKey] = {};
				}
				
				// attach members
				if(!(object instanceof Components.interfaces.nsISupports)) {
					this.importObject(object[localKey], passAsFirstArgument, attachTo[localKey]);
				}
			} else {
				attachTo[localKey] = object[localKey];
			}
		}
		
		if(newExposedProps) {
			attachTo.__exposedProps__ = newExposedProps;
		} else {
			attachTo.__exposedProps__ = object.__exposedProps__;
		}
	}
}

/**
 * This variable holds a reference to all open nsIInputStreams and nsIOutputStreams in the global  
 * scope at all times. Otherwise, our streams might get garbage collected when we allow other code
 * to run during Zotero.wait().
 */
Zotero.Translate.IO.maintainedInstances = [];

/******* (Native) Read support *******/

Zotero.Translate.IO.Read = function(file, mode) {
	Zotero.Translate.IO.maintainedInstances.push(this);
	
	this.file = file;
	
	// open file
	this._openRawStream();
	
	// start detecting charset
	var charset = null;
	
	// look for a BOM in the document
	var binStream = Components.classes["@mozilla.org/binaryinputstream;1"].
								createInstance(Components.interfaces.nsIBinaryInputStream);
	binStream.setInputStream(this._rawStream);
	var first4 = binStream.readBytes(4);

	for(var possibleCharset in BOMs) {
		if(first4.substr(0, BOMs[possibleCharset].length) == BOMs[possibleCharset]) {
			this._charset = possibleCharset;
			break;
		}
	}
	
	if(this._charset) {
		// BOM found; store its length and go back to the beginning of the file
		this._bomLength = BOMs[this._charset].length;
		this._rawStream.QueryInterface(Components.interfaces.nsISeekableStream)
			.seek(Components.interfaces.nsISeekableStream.NS_SEEK_SET, this._bomLength);
	} else {
		// look for an XML parse instruction
		this._bomLength = 0;
		
		var sStream = Components.classes["@mozilla.org/scriptableinputstream;1"]
					 .createInstance(Components.interfaces.nsIScriptableInputStream);
		sStream.init(this._rawStream);
		
		// read until we see if the file begins with a parse instruction
		const whitespaceRe = /\s/g;
		var read;
		do {
			read = sStream.read(1);
		} while(whitespaceRe.test(read))
		
		if(read == "<") {
			var firstPart = read + sStream.read(4);
			if(firstPart == "<?xml") {
				// got a parse instruction, read until it ends
				read = true;
				while((read !== false) && (read !== ">")) {
					read = sStream.read(1);
					firstPart += read;
				}
				
				const encodingRe = /encoding=['"]([^'"]+)['"]/;
				var m = encodingRe.exec(firstPart);
				if(m) {
					try {
						var charconv = Components.classes["@mozilla.org/charset-converter-manager;1"]
											   .getService(Components.interfaces.nsICharsetConverterManager)
											   .getCharsetTitle(m[1]);
						if(charconv) this._charset = m[1];
					} catch(e) {}
				}
				
				// if we know for certain document is XML, we also know for certain that the
				// default charset for XML is UTF-8
				if(!this._charset) this._charset = "UTF-8";
			}
		}
		
		// If we managed to get a charset here, then translators shouldn't be able to override it,
		// since it's almost certainly correct. Otherwise, we allow override.
		this._allowCharsetOverride = !!this._charset;		
		this._rawStream.QueryInterface(Components.interfaces.nsISeekableStream)
			.seek(Components.interfaces.nsISeekableStream.NS_SEEK_SET, this._bomLength);
		
		if(!this._charset) {
			// No XML parse instruction or BOM.
			
			// Check whether the user has specified a charset preference
			var charsetPref = Zotero.Prefs.get("import.charset");
			if(charsetPref == "auto") {
				Zotero.debug("Translate: Checking whether file is UTF-8");
				// For auto-detect, we are basically going to check if the file could be valid
				// UTF-8, and if this is true, we will treat it as UTF-8. Prior likelihood of
				// UTF-8 is very high, so this should be a reasonable strategy.
				
				// from http://codex.wordpress.org/User:Hakre/UTF8
				const UTF8Regex = new RegExp('^(?:' +
					  '[\x09\x0A\x0D\x20-\x7E]' +        // ASCII
					  '|[\xC2-\xDF][\x80-\xBF]' +        // non-overlong 2-byte
					  '|\xE0[\xA0-\xBF][\x80-\xBF]' +    // excluding overlongs
					  '|[\xE1-\xEC\xEE][\x80-\xBF]{2}' + // 3-byte, but exclude U-FFFE and U-FFFF
					  '|\xEF[\x80-\xBE][\x80-\xBF]' +
					  '|\xEF\xBF[\x80-\xBD]' +
					  '|\xED[\x80-\x9F][\x80-\xBF]' +    // excluding surrogates
					  '|\xF0[\x90-\xBF][\x80-\xBF]{2}' + // planes 1-3
					  '|[\xF1-\xF3][\x80-\xBF]{3}' +     // planes 4-15
					  '|\xF4[\x80-\x8F][\x80-\xBF]{2}' + // plane 16
					')*$');
				
				// Read all currently available bytes from file. This seems to be the entire file,
				// since the IO is blocking anyway.
				this._charset = "UTF-8";
				let bytesAvailable;
				while(bytesAvailable = this._rawStream.available()) {
					// read 131072 bytes
					let fileContents = binStream.readBytes(Math.min(131072, bytesAvailable));
					
					// on failure, try reading up to 3 more bytes and see if that makes this
					// valid (since we have chunked it)
					let isUTF8;
					for(let i=1; !(isUTF8 = UTF8Regex.test(fileContents)) && i <= 3; i++) {
						if(this._rawStream.available()) {
							fileContents += binStream.readBytes(1);
						}
					}
					
					// if the regexp continues to fail, this is not UTF-8
					if(!isUTF8) {
						// Can't be UTF-8; see if a default charset is defined
						var prefs = Components.classes["@mozilla.org/preferences-service;1"]
										.getService(Components.interfaces.nsIPrefBranch);
						try {
							this._charset = prefs.getComplexValue("intl.charset.default",
								Components.interfaces.nsIPrefLocalizedString).toString();
						} catch(e) {}
						
						if(!this._charset) {
							try {
								this._charset = prefs.getCharPref("intl.charset.default");
							} catch(e) {}
							
							
							// ISO-8859-1 by default
							if(!this._charset) this._charset = "ISO-8859-1";
						}
						
						break;
					}
				}
			} else {
				// No need to auto-detect; user has specified a charset
				this._charset = charsetPref;
			}
		}
	}
	
	Zotero.debug("Translate: Detected file charset as "+this._charset);
}

Zotero.Translate.IO.Read.prototype = {
	"__exposedProps__":{
		"_getXML":"r",
		"RDF":"r",
		"read":"r",
		"setCharacterSet":"r"
	},
	
	"_openRawStream":function() {
		if(this._rawStream) this._rawStream.close();
		this._rawStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
								  .createInstance(Components.interfaces.nsIFileInputStream);
		this._rawStream.init(this.file, 0x01, 0664, 0);
	},
	
	"_seekToStart":function(charset) {
		this._openRawStream();
		
		this._linesExhausted = false;
		this._rawStream.QueryInterface(Components.interfaces.nsISeekableStream)
			.seek(Components.interfaces.nsISeekableStream.NS_SEEK_SET, this._bomLength);
		this.bytesRead = this._bomLength;
	
		this.inputStream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
			.createInstance(Components.interfaces.nsIConverterInputStream);
		this.inputStream.init(this._rawStream, charset, 32768,
			Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
	},
	
	"_readToString":function() {
		var str = {};
		var stringBits = [];
		this.inputStream.QueryInterface(Components.interfaces.nsIUnicharInputStream);
		while(1) {
			var read = this.inputStream.readString(32768, str);
			if(!read) break;
			stringBits.push(str.value);
		}
		return stringBits.join("");
	},
	
	"_initRDF":function() {
		// get URI
		var IOService = Components.classes['@mozilla.org/network/io-service;1']
						.getService(Components.interfaces.nsIIOService);
		var fileHandler = IOService.getProtocolHandler("file")
						  .QueryInterface(Components.interfaces.nsIFileProtocolHandler);
		var baseURI = fileHandler.getURLSpecFromFile(this.file);
		
		Zotero.debug("Translate: Initializing RDF data store");
		this._dataStore = new Zotero.RDF.AJAW.RDFIndexedFormula();
		var parser = new Zotero.RDF.AJAW.RDFParser(this._dataStore);
		try {
			var nodes = Zotero.Translate.IO.parseDOMXML(this._rawStream, this._charset, this.file.fileSize);
			parser.parse(nodes, baseURI);
			
			this.RDF = new Zotero.Translate.IO._RDFSandbox(this._dataStore);
		} catch(e) {
			this.close();
			throw "Translate: No RDF found";
		}
	},
	
	"setCharacterSet":function(charset) {
		if(typeof charset !== "string") {
			throw "Translate: setCharacterSet: charset must be a string";
		}
		
		// seek back to the beginning
		this._seekToStart(this._allowCharsetOverride ? this._allowCharsetOverride : this._charset);
		
		if(!_allowCharsetOverride) {
			Zotero.debug("Translate: setCharacterSet: translate charset override ignored due to BOM or XML parse instruction");
		}
	},
	
	"read":function(bytes) {
		var str = {};
		
		if(bytes) {
			// read number of bytes requested
			this.inputStream.QueryInterface(Components.interfaces.nsIUnicharInputStream);
			var amountRead = this.inputStream.readString(bytes, str);
			if(!amountRead) return false;
			this.bytesRead += amountRead;
		} else {
			// bytes not specified; read a line
			this.inputStream.QueryInterface(Components.interfaces.nsIUnicharLineInputStream);
			if(this._linesExhausted) return false;
			this._linesExhausted = !this.inputStream.readLine(str);
			this.bytesRead += str.value.length+1; // only approximate
		}
		
		return str.value;
	},
	
	"_getXML":function() {
		if(this._mode == "xml/dom") {
			return Zotero.Translate.IO.parseDOMXML(this._rawStream, this._charset, this.file.fileSize);
		} else {
			return this._readToString().replace(/<\?xml[^>]+\?>/, "");
		}
	},
	
	"init":function(newMode, callback) {
		if(Zotero.Translate.IO.maintainedInstances.indexOf(this) === -1) {
			Zotero.Translate.IO.maintainedInstances.push(this);
		}
		this._seekToStart(this._charset);
		
		this._mode = newMode;
		if(Zotero.Translate.IO.rdfDataModes.indexOf(this._mode) !== -1 && !this.RDF) {
			this._initRDF();
		}
		
		callback(true);
	},
	
	"close":function() {
		var myIndex = Zotero.Translate.IO.maintainedInstances.indexOf(this);
		if(myIndex !== -1) Zotero.Translate.IO.maintainedInstances.splice(myIndex, 1);
		
		if(this._rawStream) {
			this._rawStream.close();
			delete this._rawStream;
		}
	}
}
Zotero.Translate.IO.Read.prototype.__defineGetter__("contentLength",
function() {
	return this.file.fileSize;
});

/******* Write support *******/

Zotero.Translate.IO.Write = function(file) {
	Zotero.Translate.IO.maintainedInstances.push(this);
	this._rawStream = Components.classes["@mozilla.org/network/file-output-stream;1"]
		.createInstance(Components.interfaces.nsIFileOutputStream);
	this._rawStream.init(file, 0x02 | 0x08 | 0x20, 0664, 0); // write, create, truncate
	this._writtenToStream = false;
}

Zotero.Translate.IO.Write.prototype = {
	"__exposedProps__":{
		"RDF":"r",
		"write":"r",
		"setCharacterSet":"r"
	},
	
	"_initRDF":function() {
		Zotero.debug("Translate: Initializing RDF data store");
		this._dataStore = new Zotero.RDF.AJAW.RDFIndexedFormula();
		this.RDF = new Zotero.Translate.IO._RDFSandbox(this._dataStore);
	},
	
	"setCharacterSet":function(charset) {
		if(typeof charset !== "string") {
			throw "Translate: setCharacterSet: charset must be a string";
		}
		
		if(!this.outputStream) {
			this.outputStream = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
								   .createInstance(Components.interfaces.nsIConverterOutputStream);
		}
		
		if(charset == "UTF-8xBOM") charset = "UTF-8";
		this.outputStream.init(this._rawStream, charset, 1024, "?".charCodeAt(0));
		this._charset = charset;
	},
	
	"write":function(data) {
		if(!this._charset) this.setCharacterSet("UTF-8");
		
		if(!this._writtenToStream && this._charset.substr(this._charset.length-4) == "xBOM"
		   && BOMs[this._charset.substr(0, this._charset.length-4).toUpperCase()]) {
			// If stream has not yet been written to, and a UTF type has been selected, write BOM
			this._rawStream.write(BOMs[streamCharset], BOMs[streamCharset].length);
		}
		
		if(this._charset == "MACINTOSH") {
			// fix buggy Mozilla MacRoman
			var splitData = data.split(/([\r\n]+)/);
			for(var i=0; i<splitData.length; i+=2) {
				// write raw newlines straight to the string
				this.outputStream.writeString(splitData[i]);
				if(splitData[i+1]) {
					this._rawStream.write(splitData[i+1], splitData[i+1].length);
				}
			}
		} else {
			this.outputStream.writeString(data);
		}
		
		this._writtenToStream = true;
	},
	
	"init":function(newMode, charset, callback) {
		this._mode = newMode;
		if(Zotero.Translate.IO.rdfDataModes.indexOf(this._mode) !== -1) {
			this._initRDF();
			if(!this._writtenToString) this.setCharacterSet("UTF-8");
		} else if(!this._writtenToString) {
			this.setCharacterSet(charset ? charset : "UTF-8");
		}
	},
	
	"close":function() {
		if(Zotero.Translate.IO.rdfDataModes.indexOf(this._mode) !== -1) {
			this.write(this.RDF.serialize());
		}
		
		var myIndex = Zotero.Translate.IO.maintainedInstances.indexOf(this);
		if(myIndex !== -1) Zotero.Translate.IO.maintainedInstances.splice(myIndex, 1);
		
		this._rawStream.close();
	}
}
